/**
 * Plain-text wholesaler demo claims end to end over the PBM Sim: RXS-0007 (email) lacks the invoice number,
 * RXS-0008 (fax) the invoice date. Each is denied once, remediated by the stub wholesaler, then settled.
 * RXS-0009 (email) is denied for the invoice number the wholesaler cannot supply, so it is abandoned and the pharmacist is texted.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { TERMINAL_STAGES, type Stage } from "@rxsolve/contracts";
import seed from "../../../seed/claims.json";
import { startSim } from "../../pbm-sim/src/server";
import { wholesalerConfig } from "../src/agents/wholesaler";
import { config } from "../src/config";
import { getDb, resetDb } from "../src/db";
import { bus } from "../src/events";
import { resetLedger } from "../src/ledger";
import { bootstrap, startApi } from "../src/server";

let sim: ReturnType<typeof startSim>;
let api: ReturnType<typeof startApi>;

beforeAll(() => {
  process.env.PBM_SIM_DELAY_SCALE = "0";
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

async function run(claimId: string): Promise<Stage> {
  const c = seed.claims.find((x) => x.claim_id === claimId)!;
  await fetch(`${sim.url}/switch/claim`, {
    method: "POST",
    body: JSON.stringify({ transaction: "B1", meta: { claim_id: claimId, ...c.meta }, request: c.request }),
  });
  for (let i = 0; i < 300; i++) {
    const s = (await getDb().claims.get(claimId))?.stage;
    if (s && TERMINAL_STAGES.includes(s)) return s;
    await Bun.sleep(10);
  }
  throw new Error(`${claimId} did not reach a terminal stage`);
}

test.each([
  ["RXS-0007", "invoice_number", "invoice number"],
  ["RXS-0008", "invoice_date", "invoice date"],
] as const)("%s: missing %s, one wholesaler request, then SETTLED", async (id, field, phrase) => {
  expect(await run(id)).toBe("SETTLED");

  const decisions = bus.history().filter((e) => e.type === "appeal.decision").map((e) => e.payload as { status: string; field: string | null });
  expect(decisions[0]).toMatchObject({ status: "DENIED", field });
  expect(decisions.at(-1)!.status).toBe("APPROVED");

  const t = (await getDb().transcript.find({ claim_id: id })).filter((m) => m.counterparty === "wholesaler");
  const asked = t.filter((m) => m.direction === "out");
  expect(asked).toHaveLength(1);
  expect(asked[0]!.text).toContain(`send the ${phrase} for NDC`);
  expect(t.filter((m) => m.direction === "in")).toHaveLength(1);
});

test("real email and fax doors: the null field is sent empty, denied, remediated, settled", async () => {
  config.adapterMode = "real";
  try {
    expect(await run("RXS-0007")).toBe("SETTLED");
    expect(await run("RXS-0008")).toBe("SETTLED");
    const d = bus.history().filter((e) => e.type === "appeal.decision").map((e) => (e.payload as { field: string | null; status: string }));
    expect(d.filter((x) => x.status === "DENIED").map((x) => x.field)).toEqual(["invoice_number", "invoice_date"]);
  } finally {
    config.adapterMode = "direct";
  }
});

test("RXS-0009: the wholesaler cannot supply the invoice number, so the claim is abandoned and the pharmacist is texted", async () => {
  expect(await run("RXS-0009")).toBe("ABANDONED");

  const decisions = bus.history().filter((e) => e.type === "appeal.decision").map((e) => e.payload as { status: string; field: string | null });
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({ status: "DENIED", field: "invoice_number" });

  const t = (await getDb().transcript.find({ claim_id: "RXS-0009" })).filter((m) => m.counterparty === "wholesaler");
  expect(t.filter((m) => m.direction === "out")).toHaveLength(1);
  expect(t.find((m) => m.direction === "in")!.text).toContain("cannot locate the invoice number");

  const pharmacist = (await getDb().transcript.find({ claim_id: "RXS-0009" })).filter((m) => m.counterparty === "pharmacist" && m.direction === "out");
  expect(pharmacist.some((m) => m.text.includes("abandoned"))).toBe(true);
  expect((await getDb().remittances.find({ claim_id: "RXS-0009" })).length).toBe(0);
});
