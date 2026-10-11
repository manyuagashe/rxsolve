/**
 * Writes the five-claim demo file for the /scan drop zone to stdout.
 *   bun scripts/demo-claims-csv.ts [YYYY-MM-DD fill date] > seed/demo-claims.csv
 * The fill date defaults to the previous business day, and each appeal deadline is the pipeline's own
 * (state window counted from the fill date). Costs are the invoice unit cost times quantity, so the scan
 * and the pipeline agree. The file carries invoice numbers and dates the pharmacy knows; RxSolve's own
 * invoice feed is missing some of them, which is what makes the PBM deny and the wholesaler get asked.
 */
import { addBusinessDays, appealDeadline } from "../apps/dashboard/lib/scanExamples";

const today = new Date().toISOString().slice(0, 10);
const fill = process.argv[2] ?? addBusinessDays(today, -1);
const deadline = appealDeadline("NC", fill);

const header = ["Claim ID", "Fill Date", "NDC", "Drug", "PBM", "State", "Total Paid", "Acquisition Cost", "Invoice Number", "Invoice Date", "Appeal Deadline", "Quantity", "Rx Number", "Plan"];
// id, ndc, drug, pbm, paid, cost, invoice number, invoice date, qty, rx
const rows: Array<[string, string, string, string, number, number, string, string, number, string]> = [
  ["DEMO-1001", "00378001801", "Metformin HCl 500 mg tab", "PBM_PORTAL", 6.4, 12.8, "INV-55120", "2026-10-01", 1000, "RX-7F3A-0412"],
  ["DEMO-1002", "00781107210", "Amlodipine 5 mg tab", "PBM_PORTAL", 12, 9, "INV-55123", "2026-10-02", 30, "RX-91B2-0377"],
  ["DEMO-1003", "00093736598", "Losartan Potassium 50 mg tab", "PBM_EMAIL", 5.4, 16.2, "INV-55126", "2026-10-03", 90, "RX-5C19-0829"],
  ["DEMO-1004", "16714029201", "Sertraline 50 mg tab", "PBM_EMAIL", 3.6, 10.5, "INV-55124", "2026-10-03", 30, "RX-3D5E-0611"],
  ["DEMO-1005", "60505260901", "Montelukast 10 mg tab", "PBM_FAX", 6.6, 13.5, "INV-55125", "2026-10-03", 30, "RX-8A21-0702"],
];
const lines = rows.map(([id, ndc, drug, pbm, paid, cost, inv, invDate, qty, rx]) =>
  [id, fill, ndc, drug, pbm, "NC", paid.toFixed(2), cost.toFixed(2), inv, invDate, deadline, qty, rx, "NC Commercial"].join(","));
console.log([header.join(","), ...lines].join("\n"));
