/**
 * Scan handoff: selected scan rows become real claims and run through the existing orchestrator.
 * The end-to-end tests use real HTTP, the PBM Sim and the local ledger, like demo-path.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { TERMINAL_STAGES, type Stage } from "@rxsolve/contracts";
import { buildHandoffExampleCsv } from "../../dashboard/lib/opportunityScan";
import { startSim } from "../../pbm-sim/src/server";
import { wholesalerConfig } from "../src/agents/wholesaler";
import { config } from "../src/config";
import { getDb, resetDb } from "../src/db";
import { bus } from "../src/events";
import { resetLedger } from "../src/ledger";
import { ledgerSummary } from "../src/ledger/settle";
import { scanOpportunityCsv, type OpportunityClaim } from "../src/opportunity-scan";
import { getPolicy, setPolicy } from "../src/policy";
import { MAX_HANDOFF_CLAIMS, toHandoffClaim } from "../src/scan-handoff";
import { bootstrap, startApi } from "../src/server";

const NOW = new Date("2026-10-12T15:00:00Z"); // a Monday
const OPTS = { now: NOW, pharmacyId: "PH-MEADOWBROOK" };

/** A ready row for a drug RxSolve has an invoice for (00093715698, unit cost $0.11). */
function row(overrides: Partial<OpportunityClaim> = {}): OpportunityClaim {
  return {
    claim_id: "HAND-001",
    fill_date: "2026-10-09",
    ndc: "00093715698",
    drug: "Atorvastatin 20 mg",
    pbm: "PBM_EMAIL",
    state: "NC",
    total_paid: 4,
    acquisition_cost: 9.9,
    invoice_number: "INV-55121",
    invoice_date: "2026-10-01",
    appeal_deadline: "2026-10-30",
    quantity: 90,
    rx_number: "7001001",
    plan: "NC Commercial",
    shortfall: 5.9,
    status: "READY",
    reason: "Underpaid, in-window, and supported by invoice evidence.",
    ...overrides,
  };
}

describe("scan CSV optional columns", () => {
  const HEADER = "Claim ID,Fill Date,NDC,Drug,PBM,State,Total Paid,Acquisition Cost,Invoice Number,Invoice Date,Appeal Deadline";
  const VALUES = "H-1,2026-10-09,00093715698,Atorvastatin,PBM_EMAIL,NC,4.00,9.90,INV-1,2026-10-01,2026-10-30";

  test("quantity, Rx number and plan are read when present", async () => {
    const result = await scanOpportunityCsv(`${HEADER},Quantity,Rx Number,Plan\n${VALUES},90,7001001,NC Commercial\n`, { now: NOW });

    expect(result.claims[0]).toMatchObject({ quantity: 90, rx_number: "7001001", plan: "NC Commercial", status: "READY" });
  });

  test("an Rx Number column before Claim ID is read as the Rx number, not the claim ID", async () => {
    const result = await scanOpportunityCsv(`Rx Number,${HEADER}\n7001001,${VALUES}\n`, { now: NOW });

    expect(result.parser.mapped_headers.claim_id).toBe("Claim ID");
    expect(result.claims[0]).toMatchObject({ claim_id: "H-1", rx_number: "7001001" });
  });

  test("a file without the optional columns still scans and reports them as null", async () => {
    const result = await scanOpportunityCsv(`${HEADER}\n${VALUES}\n`, { now: NOW });

    expect(result.claims[0]).toMatchObject({ quantity: null, rx_number: null, plan: null, status: "READY" });
  });

  test("a quantity that is not a positive number stops the scan", async () => {
    await expect(scanOpportunityCsv(`${HEADER},Quantity\n${VALUES},lots\n`, { now: NOW })).rejects.toThrow("Quantity must be a positive number");
    await expect(scanOpportunityCsv(`${HEADER},Quantity\n${VALUES},0\n`, { now: NOW })).rejects.toThrow("Quantity must be a positive number");
  });

  test("optional column names are never sent to the header-mapping model", async () => {
    const seen: string[][] = [];
    const csv = `${HEADER.replace("Drug", "Mystery Column")},Quantity,Rx Number,Plan\n${VALUES},90,7001001,NC Commercial\n`;

    await scanOpportunityCsv(csv, {
      now: NOW,
      suggestHeaders: async (unknown) => {
        seen.push(unknown);
        return [{ source: "Mystery Column", target: "drug" }];
      },
    });

    expect(seen).toEqual([["Mystery Column"]]);
  });
});

describe("toHandoffClaim", () => {
  test("builds a claim priced from RxSolve's invoice data, not the uploaded cost", () => {
    const result = toHandoffClaim(row({ acquisition_cost: 500 }), OPTS);

    if (!result.ok) throw new Error(result.reason);
    expect(result.claim).toMatchObject({
      claim_id: "HAND-001",
      pharmacy_id: "PH-MEADOWBROOK",
      pbm: "PBM_EMAIL",
      state: "NC",
      plan: "NC Commercial",
      ndc: "00093715698",
      qty: 90,
      fill_date: "2026-10-09",
      paid_amount: 4,
      acquisition_cost: 9.9, // 0.11 x 90 from the invoice fixture
    });
  });

  test("carries the Rx number in an NCPDP block so the evidence builder can find it", () => {
    const result = toHandoffClaim(row(), OPTS);

    if (!result.ok) throw new Error(result.reason);
    expect(result.claim.ncpdp?.request).toMatchObject({ "401-D1": "20261009", "402-D2": "7001001", "407-D7": "00093715698", "442-E7": 90 });
    expect(result.claim.ncpdp?.response).toMatchObject({ "509-F9": 4 });
  });

  test("uses an opaque patient reference and a default plan", () => {
    const result = toHandoffClaim(row({ plan: null }), OPTS);

    if (!result.ok) throw new Error(result.reason);
    expect(result.claim.patient_ref).toBe("PT-SCAN-HAND-001");
    expect(result.claim.plan).toBe("Historical upload");
  });

  test.each([
    [{ status: "EXPIRED" as const, reason: "The appeal deadline has passed." }, "The appeal deadline has passed."],
    [{ status: "MISSING_DATA" as const, reason: "Invoice number and date are required before filing." }, "Invoice number and date are required before filing."],
    [{ status: "PAID_FAIRLY" as const, reason: "Reimbursement met or exceeded acquisition cost." }, "Reimbursement met or exceeded acquisition cost."],
    [{ quantity: null }, "Quantity is required to price the claim."],
    [{ rx_number: null }, "Rx number is required by every PBM."],
    [{ pbm: "PBM_CARRIER_PIGEON" }, "RxSolve cannot file with PBM_CARRIER_PIGEON."],
    [{ ndc: "00054429931" }, "RxSolve has no invoice on file for this drug."],
    // NC allows 6 business days: a 2026-09-15 fill closed on 2026-09-23.
    [{ fill_date: "2026-09-15" }, "The appeal window closed on 2026-09-23."],
  ])("rejects %j", (overrides, reason) => {
    expect(toHandoffClaim(row(overrides), OPTS)).toEqual({ ok: false, reason });
  });

  test("accepts a needs-review row and a claim on the last day of its window", () => {
    expect(toHandoffClaim(row({ status: "NEEDS_REVIEW" }), OPTS).ok).toBe(true);
    // NC: 2026-10-02 plus 6 business days is 2026-10-12, which is NOW's date.
    expect(toHandoffClaim(row({ fill_date: "2026-10-02" }), OPTS).ok).toBe(true);
  });
});

describe("POST /api/opportunity-scan/handoff", () => {
  let sim: ReturnType<typeof startSim>;
  let api: ReturnType<typeof startApi>;

  beforeAll(() => {
    process.env.PBM_SIM_DELAY_SCALE = "0";
    Object.assign(config, { databaseUrl: "", agentApiKey: "", ledgerBackend: "local", adapterMode: "direct", photonProjectId: "", elevenlabsApiKey: "", elevenlabsVoiceId: "", pollIntervalMs: 10, wholesalerContact: "" });
    Object.assign(wholesalerConfig, { stub: "auto", timeoutMs: 2000 });
    sim = startSim(0);
    api = startApi(0);
    config.pbmSimUrl = sim.url;
  });
  afterAll(() => { sim.stop(); api.stop(); });
  beforeEach(async () => {
    resetDb();
    resetLedger();
    bus.clear();
    await bootstrap({ spectrum: false });
  });

  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const HEADER = "Claim ID,Fill Date,NDC,Drug,PBM,State,Total Paid,Acquisition Cost,Invoice Number,Invoice Date,Appeal Deadline,Quantity,Rx Number,Plan";
  /** Fill dates are relative to today so every row is inside the pipeline's own appeal window. */
  const csv = () => [
    HEADER,
    `HAND-001,${day(-1)},00093715698,Atorvastatin 20 mg,PBM_EMAIL,NC,4.00,9.90,INV-55121,2026-10-01,${day(10)},90,7001001,NC Commercial`,
    `HAND-002,${day(-1)},00781107210,Amlodipine 5 mg,PBM_PORTAL,NC,20.00,150.00,INV-55123,2026-10-02,${day(10)},500,7001002,NC Commercial`,
    `HAND-003,${day(-1)},00054429931,Omeprazole 20 mg,PBM_FAX,NC,2.80,6.00,INV-9,2026-10-02,${day(10)},30,7001003,NC Commercial`,
    `HAND-004,${day(-1)},00093715698,Atorvastatin 20 mg,PBM_EMAIL,NC,4.00,9.90,,,${day(10)},90,7001004,NC Commercial`,
    `HAND-005,${day(-1)},00093715698,Atorvastatin 20 mg,PBM_EMAIL,NC,0.80,1.10,INV-55121,2026-10-01,${day(10)},10,7001005,NC Commercial`,
  ].join("\n");

  const handoff = (body: unknown) => fetch(`${api.url}/api/opportunity-scan/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  type Body = { error?: string; rejected?: Array<{ claim_id: string; reason: string }> };
  const readBody = async (response: Response) => await response.json() as Body;

  async function terminalStage(claimId: string): Promise<Stage> {
    for (let i = 0; i < 300; i++) {
      const stage = (await getDb().claims.get(claimId))?.stage;
      if (stage && TERMINAL_STAGES.includes(stage)) return stage;
      await Bun.sleep(10);
    }
    throw new Error(`${claimId} did not reach a terminal stage`);
  }

  test("an in-policy claim is filed by the existing pipeline and settles on the ledger", async () => {
    const response = await handoff({ csv: csv(), claim_ids: ["HAND-001"] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      policy: { auto_file_max: 100, paused: false },
      accepted: [{ claim_id: "HAND-001", scan_shortfall: 5.9, rxsolve_shortfall: 5.9 }],
      rejected: [],
    });
    expect(await terminalStage("HAND-001")).toBe("SETTLED");
    expect(await ledgerSummary()).toMatchObject({ recovered_to_date: 5.9 });
    expect(bus.history().some((event) => event.type === "claim.received" && event.claim_id === "HAND-001")).toBe(true);
  });

  test("the saved policy gates handoff claims and stops an over-limit claim as an exception", async () => {
    await setPolicy({ ...(await getPolicy(config.pharmacyId)), auto_file_max: 50 });

    const response = await handoff({ csv: csv(), claim_ids: ["HAND-001", "HAND-002"] });

    expect((await response.json() as { policy: unknown }).policy).toEqual({ auto_file_max: 50, paused: false });
    expect(await terminalStage("HAND-002")).toBe("EXCEPTION");
    expect(await terminalStage("HAND-001")).toBe("SETTLED");
    expect(await getDb().appeals.find({ claim_id: "HAND-002" })).toEqual([]);
  });

  test("a handoff never changes the saved policy, even when a limit is sent", async () => {
    await handoff({ csv: csv(), claim_ids: ["HAND-001", "HAND-002"], auto_file_max: 500 });

    expect(await terminalStage("HAND-002")).toBe("EXCEPTION"); // $130.00 is still over the saved $100
    expect((await getPolicy(config.pharmacyId)).auto_file_max).toBe(100);
  });

  test("the policy route reports the saved limit", async () => {
    await setPolicy({ ...(await getPolicy(config.pharmacyId)), auto_file_max: 75 });

    const response = await fetch(`${api.url}/api/opportunity-scan/policy`);

    expect(await response.json()).toEqual({ auto_file_max: 75, paused: false });
  });

  test("a needs-review claim goes to the pharmacist instead of being filed", async () => {
    await handoff({ csv: csv(), claim_ids: ["HAND-005"] });

    expect(await terminalStage("HAND-005")).toBe("EXCEPTION");
    expect(await getDb().appeals.find({ claim_id: "HAND-005" })).toEqual([]);
  });

  test("rows the server would not file are rejected with a reason and never stored", async () => {
    const response = await handoff({ csv: csv(), claim_ids: ["HAND-003", "HAND-004", "HAND-404"] });

    expect(await response.json()).toEqual({
      policy: { auto_file_max: 100, paused: false },
      accepted: [],
      rejected: [
        { claim_id: "HAND-003", reason: "RxSolve has no invoice on file for this drug." },
        { claim_id: "HAND-004", reason: "Invoice number and date are required before filing." },
        { claim_id: "HAND-404", reason: "This claim is not in the uploaded file." },
      ],
    });
    expect(await getDb().claims.find()).toEqual([]);
    expect((await getPolicy(config.pharmacyId)).auto_file_max).toBe(100);
  });

  test("a claim already in RxSolve is never overwritten", async () => {
    await handoff({ csv: csv(), claim_ids: ["HAND-001"] });
    await terminalStage("HAND-001");

    const again = await handoff({ csv: csv(), claim_ids: ["HAND-001"] });

    expect((await readBody(again)).rejected).toEqual([{ claim_id: "HAND-001", reason: "This claim is already in RxSolve." }]);
    expect((await getDb().claims.get("HAND-001"))?.stage).toBe("SETTLED");
    expect(await ledgerSummary()).toMatchObject({ recovered_to_date: 5.9 });
  });

  test("a claim ID that appears twice in the file is rejected", async () => {
    const duplicated = `${csv()}\n${csv().split("\n")[1]}`;

    const response = await handoff({ csv: duplicated, claim_ids: ["HAND-001"] });

    expect((await readBody(response)).rejected).toEqual([{ claim_id: "HAND-001", reason: "This claim ID appears more than once in the file." }]);
  });

  test.each([
    [{ claim_ids: ["HAND-001"] }, "csv must be a non-empty string"],
    [{ csv: "x", claim_ids: [] }, "claim_ids must list between 1 and 25 claim IDs"],
    [{ csv: "x", claim_ids: "HAND-001" }, "claim_ids must list between 1 and 25 claim IDs"],
    [{ csv: "x", claim_ids: Array.from({ length: MAX_HANDOFF_CLAIMS + 1 }, (_, i) => `C-${i}`) }, "claim_ids must list between 1 and 25 claim IDs"],
    [{ csv: "not,a,claims,file\n1,2,3,4", claim_ids: ["HAND-001"] }, "CSV is missing required columns"],
  ])("bad request %#", async (body, message) => {
    const response = await handoff(body);

    expect(response.status).toBe(400);
    expect((await readBody(response)).error).toContain(message);
  });
});

describe("the dashboard's handoff example", () => {
  let sim: ReturnType<typeof startSim>;
  let api: ReturnType<typeof startApi>;

  beforeAll(() => {
    process.env.PBM_SIM_DELAY_SCALE = "0";
    Object.assign(config, { databaseUrl: "", agentApiKey: "", ledgerBackend: "local", adapterMode: "direct", photonProjectId: "", elevenlabsApiKey: "", elevenlabsVoiceId: "", pollIntervalMs: 10, wholesalerContact: "" });
    Object.assign(wholesalerConfig, { stub: "auto", timeoutMs: 2000 });
    sim = startSim(0);
    api = startApi(0);
    config.pbmSimUrl = sim.url;
  });
  afterAll(() => { sim.stop(); api.stop(); });
  beforeEach(async () => {
    resetDb();
    resetLedger();
    bus.clear();
    await bootstrap({ spectrum: false });
  });

  test("scans as five ready claims and one needs-review claim without calling the model", async () => {
    let modelCalls = 0;
    const result = await scanOpportunityCsv(buildHandoffExampleCsv(new Date()), {
      suggestHeaders: async () => { modelCalls++; return []; },
    });

    expect(modelCalls).toBe(0);
    expect(result.claims.map((claim) => [claim.claim_id, claim.status])).toEqual([
      ["HAND-001", "READY"], ["HAND-002", "READY"], ["HAND-003", "READY"],
      ["HAND-004", "READY"], ["HAND-005", "READY"], ["HAND-006", "NEEDS_REVIEW"],
    ]);
  });

  test("runs through the real pipeline with the outcomes the page promises", async () => {
    const ids = ["HAND-001", "HAND-002", "HAND-003", "HAND-004", "HAND-005", "HAND-006"];
    const response = await fetch(`${api.url}/api/opportunity-scan/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csv: buildHandoffExampleCsv(new Date()), claim_ids: ids }),
    });
    const body = await response.json() as { accepted: Array<{ claim_id: string; scan_shortfall: number; rxsolve_shortfall: number }>; rejected: unknown[] };

    expect(body.rejected).toEqual([{ claim_id: "HAND-005", reason: "RxSolve has no invoice on file for this drug." }]);
    // The example's cost column matches RxSolve's invoice data, so both figures agree.
    expect(body.accepted.every((claim) => claim.scan_shortfall === claim.rxsolve_shortfall)).toBe(true);

    const stages: Record<string, Stage> = {};
    for (const id of body.accepted.map((claim) => claim.claim_id)) {
      for (let i = 0; i < 400 && !stages[id]; i++) {
        const stage = (await getDb().claims.get(id))?.stage;
        if (stage && TERMINAL_STAGES.includes(stage)) stages[id] = stage;
        else await Bun.sleep(10);
      }
    }
    expect(stages).toEqual({
      "HAND-001": "SETTLED",   // email
      "HAND-002": "SETTLED",   // fax: denied first, approved on rebuttal
      "HAND-003": "EXCEPTION", // $130.00 is over the $100 limit
      "HAND-004": "SETTLED",   // portal: TN attestation denial, remediation, refile
      "HAND-006": "EXCEPTION", // marginal shortfall goes to the pharmacist
    });
    expect(await ledgerSummary()).toMatchObject({ recovered_to_date: 16.5 }); // 5.90 + 4.20 + 6.40
  });
});
