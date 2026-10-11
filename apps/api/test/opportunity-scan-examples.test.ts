import { describe, expect, test } from "bun:test";
import { buildExampleCsv, EXAMPLE_SCANS, type ExampleScanId } from "../../dashboard/lib/scanExamples";
import { deadlineFor } from "../src/deadlines";
import { scanOpportunityCsv, type ScanStatus } from "../src/opportunity-scan";
import { invoice } from "../src/reference";

const TODAY = new Date("2026-10-14T12:00:00Z"); // a Wednesday

type Expected = { statuses: ScanStatus[]; total_shortfall: number; ready_to_recover: number };

const EXPECTED: Record<ExampleScanId, Expected> = {
  mixed: {
    statuses: ["READY", "PAID_FAIRLY", "NEEDS_REVIEW", "EXPIRED", "MISSING_DATA", "READY", "READY", "PAID_FAIRLY", "READY", "READY"],
    total_shortfall: 62.3,
    ready_to_recover: 47.6,
  },
  "high-recovery": { statuses: ["READY", "READY", "READY", "READY", "READY", "READY"], total_shortfall: 385.6, ready_to_recover: 385.6 },
  "missing-evidence": { statuses: ["MISSING_DATA", "MISSING_DATA", "MISSING_DATA", "READY", "PAID_FAIRLY"], total_shortfall: 31.7, ready_to_recover: 5.9 },
  "deadline-risk": { statuses: ["READY", "READY", "READY", "EXPIRED", "EXPIRED", "PAID_FAIRLY"], total_shortfall: 63.5, ready_to_recover: 31.8 },
  "alternate-export": { statuses: ["READY", "READY", "NEEDS_REVIEW", "MISSING_DATA", "PAID_FAIRLY"], total_shortfall: 30.6, ready_to_recover: 26.8 },
  handoff: { statuses: ["READY", "READY", "READY", "READY", "READY", "NEEDS_REVIEW"], total_shortfall: 150, ready_to_recover: 149.7 },
};

const rounded = (value: number) => Math.round(value * 100) / 100;

describe("opportunity scan examples", () => {
  test("every scenario has a reviewed expectation", () => {
    expect(EXAMPLE_SCANS.map((example): string => example.id).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const { id } of EXAMPLE_SCANS) {
    test(`${id} has the reviewed row decisions and totals without calling the model`, async () => {
      let modelCalls = 0;
      const result = await scanOpportunityCsv(buildExampleCsv(id, TODAY), {
        now: TODAY,
        suggestHeaders: async () => { modelCalls++; return []; },
      });

      expect(modelCalls).toBe(0);
      expect(result.parser.mode).toBe("deterministic");
      expect(result.claims.map((claim) => claim.status)).toEqual(EXPECTED[id].statuses);
      expect(result.summary.total_shortfall).toBe(EXPECTED[id].total_shortfall);
      expect(result.summary.ready_to_recover).toBe(EXPECTED[id].ready_to_recover);
      expect(result.summary.estimated_fee).toBe(rounded(EXPECTED[id].ready_to_recover * 0.25));
    });

    test(`${id} agrees with RxSolve's own invoices and deadlines, so its claims can be handed over`, async () => {
      const result = await scanOpportunityCsv(buildExampleCsv(id, TODAY), { now: TODAY });

      for (const claim of result.claims) {
        expect(claim.quantity).not.toBeNull();
        expect(claim.rx_number).not.toBeNull();
        expect(claim.plan).not.toBeNull();
        // The file's deadline is the pipeline's deadline.
        expect(claim.appeal_deadline).toBe(deadlineFor(claim.state, claim.fill_date));

        const line = invoice(claim.ndc);
        if (claim.status === "READY" || claim.status === "NEEDS_REVIEW") {
          if (id === "handoff" && claim.claim_id === "HAND-005") continue; // the deliberate "no invoice" row
          expect(line).toBeDefined();
          expect(claim.acquisition_cost).toBe(rounded(line!.unit_cost * claim.quantity!));
        }
        if (claim.status === "MISSING_DATA" && line) {
          // The gap in the file is a gap RxSolve's invoice line really has.
          expect(line.invoice_number === null || line.invoice_date === null).toBe(true);
        }
      }
    });
  }

  test("changing row facts changes the decision instead of preserving a preset result", async () => {
    const original = buildExampleCsv("mixed", TODAY);
    const [header, first, ...rest] = original.split("\n");
    const withFirst = (edit: (fields: string[]) => void) => {
      const fields = first!.split(",");
      edit(fields);
      return [header, fields.join(","), ...rest].join("\n");
    };

    const fairlyPaid = await scanOpportunityCsv(withFirst((f) => { f[6] = "12.80"; }), { now: TODAY });
    expect(fairlyPaid.claims[0]).toMatchObject({ claim_id: "MIX-001", shortfall: 0, status: "PAID_FAIRLY" });
    expect(fairlyPaid.summary.ready_claims).toBe(4);

    const missingEvidence = await scanOpportunityCsv(withFirst((f) => { f[8] = ""; f[9] = ""; }), { now: TODAY });
    expect(missingEvidence.claims[0]).toMatchObject({ claim_id: "MIX-001", shortfall: 6.4, status: "MISSING_DATA" });

    const expired = await scanOpportunityCsv(withFirst((f) => { f[10] = "2026-10-01"; }), { now: TODAY });
    expect(expired.claims[0]).toMatchObject({ claim_id: "MIX-001", shortfall: 6.4, status: "EXPIRED" });
  });
});
