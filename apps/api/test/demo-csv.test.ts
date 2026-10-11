/**
 * The five-claim demo file (seed/demo-claims.csv) end to end: scan it, hand the underpaid rows to the
 * pipeline, and check where each claim lands. Dates in the file are re-based onto today so the test
 * keeps working after the committed file's appeal window closes.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TERMINAL_STAGES, type Stage } from "@rxsolve/contracts";
import { addBusinessDays, appealDeadline } from "../../dashboard/lib/scanExamples";
import { startSim } from "../../pbm-sim/src/server";
import { wholesalerConfig } from "../src/agents/wholesaler";
import { config } from "../src/config";
import { getDb, resetDb } from "../src/db";
import { bus } from "../src/events";
import { resetLedger } from "../src/ledger";
import { scanOpportunityCsv } from "../src/opportunity-scan";
import { handoffScanClaims } from "../src/scan-handoff";
import { bootstrap, startApi } from "../src/server";

let sim: ReturnType<typeof startSim>;
let api: ReturnType<typeof startApi>;

beforeAll(() => {
  process.env.PBM_SIM_DELAY_SCALE = "0";
  process.env.PBM_SIM_HOLD = "0";
  Object.assign(config, { databaseUrl: "", agentApiKey: "", ledgerBackend: "local", adapterMode: "direct", photonProjectId: "", elevenlabsApiKey: "", elevenlabsVoiceId: "", pollIntervalMs: 10, wholesalerContact: "" });
  Object.assign(wholesalerConfig, { stub: "auto", timeoutMs: 2000 });
  sim = startSim(0);
  api = startApi(0);
  config.pbmSimUrl = sim.url;
  process.env.CLAIM_FEED_URL = `${api.url}/api/feed/claim`;
});
afterAll(() => { sim.stop(); api.stop(); });
beforeEach(async () => {
  resetDb();
  resetLedger();
  bus.clear();
  await bootstrap({ spectrum: false });
});

/** The committed file with the fill date moved to yesterday's business day and deadlines recomputed. */
function demoCsv(): string {
  const today = new Date().toISOString().slice(0, 10);
  const fill = addBusinessDays(today, -1);
  const [header, ...rows] = readFileSync(new URL("../../../seed/demo-claims.csv", import.meta.url), "utf8").trim().split("\n");
  return [header, ...rows.map((row) => {
    const f = row.split(",");
    f[1] = fill;
    f[10] = appealDeadline("NC", fill);
    return f.join(",");
  })].join("\n");
}

async function stageOf(claimId: string): Promise<Stage> {
  for (let i = 0; i < 400; i++) {
    const s = (await getDb().claims.get(claimId))?.stage;
    if (s && TERMINAL_STAGES.includes(s)) return s;
    await Bun.sleep(10);
  }
  throw new Error(`${claimId} did not reach a terminal stage`);
}

test("the demo file scans as one fairly paid claim and four ready ones", async () => {
  const scan = await scanOpportunityCsv(demoCsv());
  expect(scan.claims.map((c) => [c.claim_id, c.status])).toEqual([
    ["DEMO-1001", "READY"], ["DEMO-1002", "PAID_FAIRLY"], ["DEMO-1003", "READY"], ["DEMO-1004", "READY"], ["DEMO-1005", "READY"],
  ]);
  expect(scan.summary.ready_to_recover).toBe(6.4 + 10.8 + 6.9 + 6.9);
});

test("handoff: portal approves straight through, email and fax recover, Losartan is abandoned and the pharmacist is texted", async () => {
  const csv = demoCsv();
  const result = await handoffScanClaims({ csv, claimIds: ["DEMO-1001", "DEMO-1002", "DEMO-1003", "DEMO-1004", "DEMO-1005"] });
  expect(result.accepted.map((a) => a.claim_id)).toEqual(["DEMO-1001", "DEMO-1003", "DEMO-1004", "DEMO-1005"]);
  expect(result.rejected.map((r) => r.claim_id)).toEqual(["DEMO-1002"]);

  expect(await stageOf("DEMO-1001")).toBe("SETTLED");
  expect(await stageOf("DEMO-1004")).toBe("SETTLED");
  expect(await stageOf("DEMO-1005")).toBe("SETTLED");
  expect(await stageOf("DEMO-1003")).toBe("ABANDONED");

  const decisions = (claimId: string) => bus.history()
    .filter((e) => e.type === "appeal.decision" && e.claim_id === claimId)
    .map((e) => e.payload as { status: string; field: string | null });
  expect(decisions("DEMO-1001").map((d) => d.status)).toEqual(["APPROVED"]);
  expect(decisions("DEMO-1004")[0]).toMatchObject({ status: "DENIED", field: "invoice_number" });
  expect(decisions("DEMO-1005")[0]).toMatchObject({ status: "DENIED", field: "invoice_date" });
  expect(decisions("DEMO-1003")).toHaveLength(1);

  const told = (await getDb().transcript.find({ claim_id: "DEMO-1003" })).filter((m) => m.counterparty === "pharmacist" && m.direction === "out");
  expect(told.some((m) => m.text.includes("abandoned"))).toBe(true);
});
