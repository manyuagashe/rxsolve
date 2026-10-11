import { describe, expect, test } from "bun:test";
import {
  applySuggestedHeaderMappings,
  scanOpportunityCsv,
  type SuggestedHeaderMapping,
} from "../src/opportunity-scan";
import { scanRoutes } from "../src/routes/scan";

const CSV = `Claim ID,Fill Date,NDC,Drug,PBM,State,Total Paid,Acquisition Cost,Invoice Number,Invoice Date,Appeal Deadline
HIST-001,2026-09-15,00011122233,Metformin 500 mg,PBM_PORTAL,NC,6.40,12.80,INV-1001,2026-09-01,2026-10-20
HIST-002,2026-09-16,00011122244,Amlodipine 5 mg,PBM_EMAIL,NC,9.00,8.20,INV-1002,2026-09-01,2026-10-20
HIST-003,2026-09-17,00011122255,Lisinopril 10 mg,PBM_FAX,GA,7.70,8.00,INV-1003,2026-09-02,2026-10-20
HIST-004,2026-08-01,00011122266,Sertraline 50 mg,PBM_EMAIL,TN,4.00,10.00,INV-1004,2026-07-25,2026-09-01
HIST-005,2026-09-18,00011122277,Montelukast 10 mg,PBM_PORTAL,TN,5.00,11.00,,,2026-10-20`;

describe("opportunity scan", () => {
  test("classifies historical claims and totals only currently recoverable dollars", async () => {
    const result = await scanOpportunityCsv(CSV, { now: new Date("2026-10-11T12:00:00Z") });

    expect(result.parser.mode).toBe("deterministic");
    expect(result.summary).toEqual({
      claims_scanned: 5,
      underpaid_claims: 4,
      ready_claims: 1,
      needs_review_claims: 1,
      missing_data_claims: 1,
      expired_claims: 1,
      paid_fairly_claims: 1,
      total_shortfall: 18.7,
      ready_to_recover: 6.4,
      estimated_fee: 1.6,
      estimated_pharmacy_net: 4.8,
    });
    expect(result.claims.map((claim) => [claim.claim_id, claim.status])).toEqual([
      ["HIST-001", "READY"],
      ["HIST-002", "PAID_FAIRLY"],
      ["HIST-003", "NEEDS_REVIEW"],
      ["HIST-004", "EXPIRED"],
      ["HIST-005", "MISSING_DATA"],
    ]);
  });

  test("maps known pharmacy-export aliases without a model", async () => {
    const csv = `Rx Reference,Date of Service,Product ID,Medication,Payer,Pharmacy State,Amount Received,Drug Cost,Invoice #,Invoice Date,Appeal By
RX-9,2026-10-01,12345,Example Drug,PBM_EMAIL,NC,4.00,9.00,INV-9,2026-09-30,2026-10-25`;

    const result = await scanOpportunityCsv(csv, { now: new Date("2026-10-11T12:00:00Z") });

    expect(result.parser.mode).toBe("deterministic");
    expect(result.claims[0]).toMatchObject({ claim_id: "RX-9", status: "READY", shortfall: 5 });
  });

  test("uses a bounded mapper only for unknown headers and marks the result as assisted", async () => {
    const csv = `Reference,Dispensed,Product,Medicine,Payer Name,Jurisdiction,Net Pharmacy Revenue,Wholesale Cost,Invoice Ref,Invoice Issued,File Before
RX-10,2026-10-01,12345,Example Drug,PBM_EMAIL,NC,4.00,9.00,INV-10,2026-09-30,2026-10-25`;
    let received: string[] = [];

    const result = await scanOpportunityCsv(csv, {
      now: new Date("2026-10-11T12:00:00Z"),
      suggestHeaders: async (headers) => {
        received = headers;
        return [
          ["Reference", "claim_id"], ["Dispensed", "fill_date"], ["Product", "ndc"],
          ["Medicine", "drug"], ["Payer Name", "pbm"], ["Jurisdiction", "state"],
          ["Net Pharmacy Revenue", "total_paid"], ["Wholesale Cost", "acquisition_cost"],
          ["Invoice Ref", "invoice_number"], ["Invoice Issued", "invoice_date"],
          ["File Before", "appeal_deadline"],
        ].map(([source, target]) => ({ source, target })) as SuggestedHeaderMapping[];
      },
    });

    expect(received).toContain("Net Pharmacy Revenue");
    expect(result.parser.mode).toBe("llm_assisted");
    expect(result.claims[0]).toMatchObject({ claim_id: "RX-10", status: "READY", shortfall: 5 });
  });

  test("rejects mappings that invent a source header or assign one target twice", () => {
    expect(() => applySuggestedHeaderMappings(
      ["Reference", "Paid"],
      {},
      [{ source: "Made Up", target: "claim_id" }],
    )).toThrow("unknown source header");

    expect(() => applySuggestedHeaderMappings(
      ["Reference", "Other Reference"],
      {},
      [
        { source: "Reference", target: "claim_id" },
        { source: "Other Reference", target: "claim_id" },
      ],
    )).toThrow("maps more than one source");

    expect(() => applySuggestedHeaderMappings(
      ["Reference"],
      {},
      [
        { source: "Reference", target: "claim_id" },
        { source: "Reference", target: "ndc" },
      ],
    )).toThrow("maps one source to more than one target");
  });

  test("rejects malformed money instead of guessing", async () => {
    const csv = `Claim ID,Fill Date,NDC,Drug,PBM,State,Total Paid,Acquisition Cost,Invoice Number,Invoice Date,Appeal Deadline
BAD-1,2026-10-01,12345,Example Drug,PBM_EMAIL,NC,unknown,9.00,INV-1,2026-09-30,2026-10-25`;

    await expect(scanOpportunityCsv(csv, { now: new Date("2026-10-11T12:00:00Z") }))
      .rejects.toThrow("Total Paid must be a non-negative amount");
  });

  test("rejects impossible dates and malformed optional invoice dates", async () => {
    const impossibleFillDate = CSV.replace("2026-09-15", "2026-02-31");
    await expect(scanOpportunityCsv(impossibleFillDate, { now: new Date("2026-10-11T12:00:00Z") }))
      .rejects.toThrow("Fill Date must use YYYY-MM-DD");

    const malformedInvoiceDate = CSV.replace("2026-09-01,2026-10-20", "09/01/2026,2026-10-20");
    await expect(scanOpportunityCsv(malformedInvoiceDate, { now: new Date("2026-10-11T12:00:00Z") }))
      .rejects.toThrow("Invoice Date must use YYYY-MM-DD");
  });

  test("exposes the scan over HTTP without persisting or filing claims", async () => {
    const response = await scanRoutes["/api/opportunity-scan"].POST(new Request("http://local/api/opportunity-scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csv: CSV, now: "2026-10-11T12:00:00Z" }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json() as { summary: { ready_claims: number }; claims: unknown[] };
    expect(body.summary.ready_claims).toBe(1);
    expect(body.claims).toHaveLength(5);
  });

  test("returns an actionable 400 for invalid scan input", async () => {
    const response = await scanRoutes["/api/opportunity-scan"].POST(new Request("http://local/api/opportunity-scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csv: "Claim ID\nX" }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringContaining("missing required columns") });
  });
});
