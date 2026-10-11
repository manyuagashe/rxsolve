/**
 * Example files for the historical scan. Built fresh against today so every scenario keeps the
 * outcome it promises: open claims stay inside the pipeline's appeal window and late ones stay late.
 *
 * Every sendable row uses a drug RxSolve has an invoice for, and its cost is that invoice's unit cost
 * times the quantity (apps/api/src/fixtures/invoices.json), so the scan's estimate and the pipeline's
 * own pricing agree. Deadlines use the pipeline's statute windows (apps/api/src/fixtures/statutes.json).
 * apps/api/test/scan-examples.test.ts checks both against the API's own data.
 */

/** Appeal windows in business days, mirroring statutes.json. */
const WINDOW_BUSINESS_DAYS: Record<string, number> = { NC: 6, TN: 7, GA: 10 };

/** Moves a YYYY-MM-DD date by whole business days (negative goes back), skipping weekends. */
export function addBusinessDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  const step = days < 0 ? -1 : 1;
  let left = Math.abs(days);
  while (left > 0) {
    date.setUTCDate(date.getUTCDate() + step);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) left--;
  }
  return date.toISOString().slice(0, 10);
}

/** The pipeline's deadline: the state's window counted from the fill date. */
export const appealDeadline = (state: string, fillDate: string) => addBusinessDays(fillDate, WINDOW_BUSINESS_DAYS[state] ?? 20);

type Drug = { ndc: string; name: string; unitCost: number | null; invoiceNumber: string | null; invoiceDate: string | null };

/** Invoice lines from apps/api/src/fixtures/invoices.json; unitCost null means RxSolve has no invoice. */
const DRUGS = {
  metformin: { ndc: "00378001801", name: "Metformin HCl 500 mg", unitCost: 0.0128, invoiceNumber: "INV-55120", invoiceDate: "2026-10-01" },
  atorvastatin: { ndc: "00093715698", name: "Atorvastatin 20 mg", unitCost: 0.11, invoiceNumber: "INV-55121", invoiceDate: "2026-10-01" },
  lisinopril: { ndc: "68180051301", name: "Lisinopril 10 mg", unitCost: 0.15, invoiceNumber: "INV-55122", invoiceDate: "2026-10-02" },
  amlodipine: { ndc: "00781107210", name: "Amlodipine 5 mg", unitCost: 0.3, invoiceNumber: "INV-55123", invoiceDate: "2026-10-02" },
  sertraline: { ndc: "16714029201", name: "Sertraline 50 mg", unitCost: 0.35, invoiceNumber: null, invoiceDate: "2026-10-03" },
  montelukast: { ndc: "60505260901", name: "Montelukast 10 mg", unitCost: 0.45, invoiceNumber: "INV-55125", invoiceDate: null },
  losartan: { ndc: "00093736598", name: "Losartan Potassium 50 mg", unitCost: 0.18, invoiceNumber: null, invoiceDate: "2026-10-03" },
  omeprazole: { ndc: "00054429931", name: "Omeprazole 20 mg", unitCost: null, invoiceNumber: "INV-90001", invoiceDate: "2026-10-02" },
} satisfies Record<string, Drug>;

const PLANS: Record<string, string> = { NC: "NC Commercial", GA: "GA Medicaid MCO", TN: "TN Part D" };

type Row = {
  id: string;
  drug: Drug;
  pbm: "PBM_PORTAL" | "PBM_EMAIL" | "PBM_FAX";
  state: "NC" | "GA" | "TN";
  qty: number;
  paid: number;
  /** Business days before today the claim was filled. */
  filledAgo: number;
  /** Cost for a drug without an invoice line (the pharmacy's own figure). */
  cost?: number;
};

const money = (value: number) => (Math.round(value * 100) / 100).toFixed(2);
const rxNumber = (id: string) => `70${id.replace(/\D/g, "").padStart(5, "0")}`;

const DEFAULT_HEADER = ["Claim ID", "Fill Date", "NDC", "Drug", "PBM", "State", "Total Paid", "Acquisition Cost", "Invoice Number", "Invoice Date", "Appeal Deadline", "Quantity", "Rx Number", "Plan"];
const ALIAS_HEADER = ["Rx Reference", "Date of Service", "Product ID", "Medication", "Payer", "Pharmacy State", "Amount Received", "Drug Cost", "Invoice", "Invoice Issued", "Appeal By", "Qty", "Rx No", "Plan Name"];

function toCsv(rows: Row[], today: Date, header = DEFAULT_HEADER): string {
  const day = today.toISOString().slice(0, 10);
  const lines = rows.map((row) => {
    const fill = addBusinessDays(day, -row.filledAgo);
    const cost = row.drug.unitCost === null ? row.cost ?? 0 : row.drug.unitCost * row.qty;
    return [
      row.id, fill, row.drug.ndc, row.drug.name, row.pbm, row.state, money(row.paid), money(cost),
      row.drug.invoiceNumber ?? "", row.drug.invoiceDate ?? "", appealDeadline(row.state, fill),
      String(row.qty), rxNumber(row.id), PLANS[row.state],
    ].join(",");
  });
  return [header.join(","), ...lines].join("\n");
}

const { metformin, atorvastatin, lisinopril, amlodipine, sertraline, montelukast, losartan, omeprazole } = DRUGS;

const SCENARIOS = {
  mixed: () => [
    { id: "MIX-001", drug: metformin, pbm: "PBM_PORTAL", state: "NC", qty: 1000, paid: 6.4, filledAgo: 2 },
    { id: "MIX-002", drug: amlodipine, pbm: "PBM_EMAIL", state: "NC", qty: 30, paid: 9.5, filledAgo: 2 },
    { id: "MIX-003", drug: lisinopril, pbm: "PBM_FAX", state: "GA", qty: 30, paid: 4.2, filledAgo: 3 },
    { id: "MIX-004", drug: atorvastatin, pbm: "PBM_EMAIL", state: "TN", qty: 90, paid: 4, filledAgo: 15 },
    { id: "MIX-005", drug: montelukast, pbm: "PBM_FAX", state: "NC", qty: 30, paid: 5, filledAgo: 2 },
    { id: "MIX-006", drug: atorvastatin, pbm: "PBM_FAX", state: "GA", qty: 90, paid: 4, filledAgo: 3 },
    { id: "MIX-007", drug: lisinopril, pbm: "PBM_EMAIL", state: "NC", qty: 60, paid: 4.8, filledAgo: 1 },
    { id: "MIX-008", drug: omeprazole, pbm: "PBM_PORTAL", state: "NC", qty: 30, paid: 6.4, filledAgo: 1, cost: 6 },
    { id: "MIX-009", drug: amlodipine, pbm: "PBM_PORTAL", state: "TN", qty: 90, paid: 11.5, filledAgo: 2 },
    { id: "MIX-010", drug: metformin, pbm: "PBM_FAX", state: "NC", qty: 2000, paid: 10, filledAgo: 1 },
  ],
  "high-recovery": () => [
    { id: "HIGH-001", drug: amlodipine, pbm: "PBM_PORTAL", state: "NC", qty: 300, paid: 12, filledAgo: 1 },
    { id: "HIGH-002", drug: atorvastatin, pbm: "PBM_EMAIL", state: "NC", qty: 600, paid: 9, filledAgo: 2 },
    { id: "HIGH-003", drug: amlodipine, pbm: "PBM_FAX", state: "GA", qty: 500, paid: 20, filledAgo: 3 },
    { id: "HIGH-004", drug: lisinopril, pbm: "PBM_PORTAL", state: "GA", qty: 400, paid: 6, filledAgo: 2 },
    { id: "HIGH-005", drug: metformin, pbm: "PBM_EMAIL", state: "NC", qty: 3000, paid: 6, filledAgo: 1 },
    { id: "HIGH-006", drug: atorvastatin, pbm: "PBM_FAX", state: "TN", qty: 360, paid: 5.4, filledAgo: 2 },
  ],
  "missing-evidence": () => [
    { id: "EVID-001", drug: sertraline, pbm: "PBM_EMAIL", state: "NC", qty: 30, paid: 4, filledAgo: 1 },
    { id: "EVID-002", drug: montelukast, pbm: "PBM_FAX", state: "NC", qty: 30, paid: 5, filledAgo: 2 },
    { id: "EVID-003", drug: losartan, pbm: "PBM_EMAIL", state: "NC", qty: 90, paid: 5.4, filledAgo: 1 },
    { id: "EVID-004", drug: atorvastatin, pbm: "PBM_PORTAL", state: "NC", qty: 90, paid: 4, filledAgo: 2 },
    { id: "EVID-005", drug: lisinopril, pbm: "PBM_EMAIL", state: "GA", qty: 30, paid: 5, filledAgo: 3 },
  ],
  "deadline-risk": () => [
    // Filled two business days before the window closes, so each is open but urgent.
    { id: "DATE-001", drug: metformin, pbm: "PBM_PORTAL", state: "NC", qty: 1000, paid: 5, filledAgo: 4 },
    { id: "DATE-002", drug: lisinopril, pbm: "PBM_FAX", state: "GA", qty: 60, paid: 3, filledAgo: 8 },
    { id: "DATE-003", drug: amlodipine, pbm: "PBM_EMAIL", state: "TN", qty: 90, paid: 9, filledAgo: 5 },
    // Filled after the window closed.
    { id: "DATE-004", drug: atorvastatin, pbm: "PBM_PORTAL", state: "NC", qty: 270, paid: 10, filledAgo: 12 },
    { id: "DATE-005", drug: amlodipine, pbm: "PBM_EMAIL", state: "TN", qty: 60, paid: 6, filledAgo: 14 },
    { id: "DATE-006", drug: lisinopril, pbm: "PBM_FAX", state: "NC", qty: 30, paid: 5, filledAgo: 2 },
  ],
  "alternate-export": () => [
    { id: "ALT-001", drug: metformin, pbm: "PBM_PORTAL", state: "NC", qty: 1000, paid: 5, filledAgo: 2 },
    { id: "ALT-002", drug: amlodipine, pbm: "PBM_EMAIL", state: "NC", qty: 90, paid: 8, filledAgo: 1 },
    { id: "ALT-003", drug: lisinopril, pbm: "PBM_FAX", state: "GA", qty: 30, paid: 4.2, filledAgo: 3 },
    { id: "ALT-004", drug: montelukast, pbm: "PBM_PORTAL", state: "NC", qty: 30, paid: 10, filledAgo: 2 },
    { id: "ALT-005", drug: omeprazole, pbm: "PBM_EMAIL", state: "NC", qty: 30, paid: 7, filledAgo: 1, cost: 6 },
  ],
  handoff: () => [
    { id: "HAND-001", drug: atorvastatin, pbm: "PBM_EMAIL", state: "NC", qty: 90, paid: 4, filledAgo: 1 },
    { id: "HAND-002", drug: lisinopril, pbm: "PBM_FAX", state: "GA", qty: 60, paid: 4.8, filledAgo: 1 },
    { id: "HAND-003", drug: amlodipine, pbm: "PBM_PORTAL", state: "NC", qty: 500, paid: 20, filledAgo: 1 },
    { id: "HAND-004", drug: metformin, pbm: "PBM_PORTAL", state: "TN", qty: 1000, paid: 6.4, filledAgo: 1 },
    { id: "HAND-005", drug: omeprazole, pbm: "PBM_FAX", state: "NC", qty: 30, paid: 2.8, filledAgo: 1, cost: 6 },
    { id: "HAND-006", drug: atorvastatin, pbm: "PBM_EMAIL", state: "NC", qty: 10, paid: 0.8, filledAgo: 1 },
  ],
} satisfies Record<string, () => Row[]>;

export type ExampleScanId = keyof typeof SCENARIOS;

export const EXAMPLE_SCANS: ReadonlyArray<{ id: ExampleScanId; name: string; description: string }> = [
  { id: "mixed", name: "Mixed claim outcomes", description: "Ready, review, missing evidence, expired, and fairly paid claims in one file." },
  { id: "high-recovery", name: "High recovery opportunity", description: "Six complete claims with large shortfalls. One is over the $100 auto-file limit." },
  { id: "missing-evidence", name: "Missing invoice evidence", description: "Claims that need an invoice number or date before RxSolve can file them." },
  { id: "deadline-risk", name: "Deadline risk", description: "Open claims two business days from their deadline, next to claims already too late." },
  { id: "alternate-export", name: "Different column names", description: "A pharmacy export that uses common aliases instead of RxSolve's labels." },
  { id: "handoff", name: "Ready for RxSolve handoff", description: "One claim per channel, one over the limit, and one drug RxSolve has no invoice for." },
];

/** The example file for a scenario, dated around `today`. */
export function buildExampleCsv(id: ExampleScanId, today: Date): string {
  return toCsv(SCENARIOS[id]() as Row[], today, id === "alternate-export" ? ALIAS_HEADER : DEFAULT_HEADER);
}

/** File name for downloading a scenario, so the upload path can be tried with the same data. */
export const exampleFileName = (id: ExampleScanId) => `rxsolve-example-${id}.csv`;

/** The handoff scenario, kept as its own export for the API's end-to-end tests. */
export const buildHandoffExampleCsv = (today: Date) => buildExampleCsv("handoff", today);
