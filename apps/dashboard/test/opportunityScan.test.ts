import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OpportunityScan } from "../components/scan/OpportunityScan";
import { PolicySetup } from "../components/scan/PolicySetup";
import { ScanHandoff } from "../components/scan/ScanHandoff";
import {
  DEFAULT_AUTO_FILE_MAX,
  handoffBlocker,
  handoffPolicyNote,
  MAX_HANDOFF_CLAIMS,
  MINIMUM_SCAN_DURATION_MS,
  parseAutoFileMax,
  previewMismatchNote,
  previewPolicy,
  readyClaimIds,
  remainingScanDelay,
  reviewQueue,
  scanStatusPresentation,
  toggleSelected,
} from "../lib/opportunityScan";
import { addBusinessDays, appealDeadline, buildExampleCsv, buildHandoffExampleCsv, EXAMPLE_SCANS } from "../lib/scanExamples";

test("scan statuses have plain-language labels and semantic tones", () => {
  expect(scanStatusPresentation("READY")).toEqual({ label: "Ready for RxSolve", tone: "good" });
  expect(scanStatusPresentation("PAID_FAIRLY")).toEqual({ label: "Paid fairly", tone: "muted" });
  expect(scanStatusPresentation("NEEDS_REVIEW")).toEqual({ label: "Needs review", tone: "warn" });
  expect(scanStatusPresentation("MISSING_DATA")).toEqual({ label: "Missing evidence", tone: "warn" });
  expect(scanStatusPresentation("EXPIRED")).toEqual({ label: "Deadline expired", tone: "bad" });
});

test("only ready claims are staged for the next RxSolve step", () => {
  expect(readyClaimIds([
    { claim_id: "A", status: "READY" },
    { claim_id: "B", status: "NEEDS_REVIEW" },
    { claim_id: "C", status: "READY" },
    { claim_id: "D", status: "MISSING_DATA" },
  ])).toEqual(["A", "C"]);
});

test("scan feedback lasts long enough to be visible without delaying slow work", () => {
  expect(MINIMUM_SCAN_DURATION_MS).toBe(1_200);
  expect(remainingScanDelay(1_000, 1_500)).toBe(700);
  expect(remainingScanDelay(1_000, 2_500)).toBe(0);
});

test("scan intake offers six built-in scenarios directly with concise copy", () => {
  const html = renderToStaticMarkup(createElement(OpportunityScan));

  expect(EXAMPLE_SCANS).toHaveLength(6);
  expect(new Set(EXAMPLE_SCANS.map((example) => example.id)).size).toBe(6);
  expect(html.match(/<option/g)).toHaveLength(6);
  expect(html).toContain("Run example CSV");
  expect(html).toContain("Choose a CSV");
  expect(html.indexOf("Run example CSV")).toBeLessThan(html.indexOf("Choose a CSV"));
  expect(html).toContain('<button class="btn btn--ghost" type="button" aria-controls="scan-summary"');
  expect(html).toContain('<label class="btn scan-file">');
  expect(html).toContain("Download this example to try the upload");
  expect(html).not.toContain("scan-privacy");
  expect(html).not.toContain("—");
});

// --- Review queue and policy setup -------------------------------------------------------------

const QUEUE_CLAIMS = [
  { claim_id: "A", drug: "Metformin", pbm: "PBM_PORTAL", status: "READY", shortfall: 6.4, reason: "" },
  { claim_id: "B", drug: "Lisinopril", pbm: "PBM_FAX", status: "NEEDS_REVIEW", shortfall: 0.3, reason: "" },
  { claim_id: "C", drug: "Insulin", pbm: "PBM_EMAIL", status: "READY", shortfall: 137.6, reason: "" },
  { claim_id: "D", drug: "Montelukast", pbm: "PBM_PORTAL", status: "MISSING_DATA", shortfall: 6, reason: "" },
  { claim_id: "E", drug: "Sertraline", pbm: "PBM_EMAIL", status: "EXPIRED", shortfall: 6, reason: "" },
  { claim_id: "F", drug: "Amlodipine", pbm: "PBM_EMAIL", status: "PAID_FAIRLY", shortfall: 0, reason: "" },
] as const;

test("the review queue combines ready and needs-review claims and nothing else", () => {
  expect(reviewQueue(QUEUE_CLAIMS).map((claim) => claim.claim_id)).toEqual(["A", "B", "C"]);
});

test("toggling a claim returns a new selection without changing the old one", () => {
  const before = ["A", "C"];

  expect(toggleSelected(before, "C")).toEqual(["A"]);
  expect(toggleSelected(before, "B")).toEqual(["A", "C", "B"]);
  expect(before).toEqual(["A", "C"]);
});

test("the auto-file limit accepts plain dollar amounts and rejects everything else", () => {
  expect(DEFAULT_AUTO_FILE_MAX).toBe(100);
  expect(parseAutoFileMax("100")).toBe(100);
  expect(parseAutoFileMax(" $25.50 ")).toBe(25.5);
  expect(parseAutoFileMax("0")).toBe(0);
  expect(parseAutoFileMax("")).toBeNull();
  expect(parseAutoFileMax("-5")).toBeNull();
  expect(parseAutoFileMax("abc")).toBeNull();
  expect(parseAutoFileMax("1e3")).toBeNull();
});

test("policy preview routes selected claims by the dollar limit and review status", () => {
  const preview = previewPolicy(QUEUE_CLAIMS, ["A", "B", "C"], 100);

  expect(preview.autoFile.map((claim) => claim.claim_id)).toEqual(["A"]);
  expect(preview.needsApproval.map((entry) => entry.claim.claim_id)).toEqual(["B", "C"]);
  expect(preview.needsApproval[0]!.why).toBe("Small shortfall needs pharmacist review");
  expect(preview.needsApproval[1]!.why).toBe("$137.60 is over the $100.00 auto-file limit");
  expect(preview.autoFileTotal).toBe(6.4);
  expect(preview.needsApprovalTotal).toBe(137.9);
  expect(preview.selectedTotal).toBe(144.3);
});

test("policy preview treats a shortfall equal to the limit as inside the policy", () => {
  // Mirrors apps/api/src/policy.ts, which blocks only when the delta is strictly over the limit.
  expect(previewPolicy(QUEUE_CLAIMS, ["A"], 6.4).autoFile).toHaveLength(1);
  expect(previewPolicy(QUEUE_CLAIMS, ["A"], 6.39).autoFile).toHaveLength(0);
});

test("policy preview ignores unselected claims and claims outside the review queue", () => {
  const preview = previewPolicy(QUEUE_CLAIMS, ["A", "D", "E", "F", "missing"], 100);

  expect(preview.autoFile.map((claim) => claim.claim_id)).toEqual(["A"]);
  expect(preview.needsApproval).toEqual([]);
  expect(preview.selectedTotal).toBe(6.4);
});

test("policy setup preselects ready claims and previews the default limit without filing", () => {
  const html = renderToStaticMarkup(createElement(PolicySetup, { claims: [...QUEUE_CLAIMS], csv: "csv text" }));

  // One checkbox per queued claim, plus the unticked handoff confirmation.
  expect(html.match(/aria-label="Include /g)).toHaveLength(3);
  expect(html.match(/type="checkbox"/g)).toHaveLength(4);
  expect(html.match(/checked=""/g)).toHaveLength(2);
  expect(html).toContain('value="100"');
  expect(html).toContain("<b>1 claim</b> would file automatically ($6.40)");
  expect(html).toContain("<b>1 claim</b> would wait for your approval ($137.60)");
  expect(html).toContain("Nothing is filed until you send claims to RxSolve");
  expect(html).not.toContain("Montelukast");
  expect(html).not.toContain("—");
});

// --- Handoff to the claim pipeline -------------------------------------------------------------

test("the handoff example is built around today so its claims are inside the appeal window", () => {
  // 2026-10-12 is a Monday: filled one business day earlier, each deadline is the state's window.
  const lines = buildHandoffExampleCsv(new Date("2026-10-12T15:00:00Z")).split("\n");
  const rows = lines.slice(1).map((line) => line.split(","));

  expect(lines[0]).toBe("Claim ID,Fill Date,NDC,Drug,PBM,State,Total Paid,Acquisition Cost,Invoice Number,Invoice Date,Appeal Deadline,Quantity,Rx Number,Plan");
  expect(rows.map((row) => row[0])).toEqual(["HAND-001", "HAND-002", "HAND-003", "HAND-004", "HAND-005", "HAND-006"]);
  expect(rows.every((row) => row[1] === "2026-10-09")).toBe(true);
  expect(rows.map((row) => [row[5], row[10]])).toEqual([
    ["NC", "2026-10-19"], ["GA", "2026-10-23"], ["NC", "2026-10-19"], ["TN", "2026-10-20"], ["NC", "2026-10-19"], ["NC", "2026-10-19"],
  ]);
});

test("business days skip weekends in both directions", () => {
  expect(addBusinessDays("2026-10-12", -1)).toBe("2026-10-09");
  expect(addBusinessDays("2026-10-09", 1)).toBe("2026-10-12");
  expect(appealDeadline("GA", "2026-10-09")).toBe("2026-10-23");
});

test("every example scenario is generated with the columns the handoff needs", () => {
  for (const { id } of EXAMPLE_SCANS) {
    const [header] = buildExampleCsv(id, new Date("2026-10-12T15:00:00Z")).split("\n");
    expect(header!.split(",").slice(-3)).toEqual(id === "alternate-export" ? ["Qty", "Rx No", "Plan Name"] : ["Quantity", "Rx Number", "Plan"]);
  }
});

test("the send button explains what is still missing, in order", () => {
  expect(MAX_HANDOFF_CLAIMS).toBe(25);
  expect(handoffBlocker({ selectedCount: 0, confirmed: true })).toBe("Select at least one claim.");
  expect(handoffBlocker({ selectedCount: 26, confirmed: true })).toBe("Send 25 claims or fewer at a time.");
  expect(handoffBlocker({ selectedCount: 2, confirmed: false })).toBe("Tick the box to confirm.");
  expect(handoffBlocker({ selectedCount: 2, confirmed: true })).toBeNull();
});

test("the handoff names the saved limit it runs under, and flags a preview that differs", () => {
  const saved = { auto_file_max: 100, paused: false };

  expect(handoffPolicyNote(saved)).toBe("Claims over your saved $100.00 auto-file limit wait for your approval. Others can file real appeals.");
  expect(handoffPolicyNote({ ...saved, paused: true })).toBe("Auto-filing is paused, so every claim will wait for your approval.");
  expect(handoffPolicyNote(null)).toBe("Claims run under your saved auto-file limit and can file real appeals.");
  expect(previewMismatchNote(saved, 100)).toBeNull();
  expect(previewMismatchNote(saved, null)).toBeNull();
  expect(previewMismatchNote(null, 250)).toBeNull();
  expect(previewMismatchNote(saved, 250)).toBe("The limit above is a preview. Sending uses your saved $100.00 limit.");
});

test("the handoff control starts unconfirmed and says plainly that it files appeals", () => {
  const html = renderToStaticMarkup(createElement(ScanHandoff, { csv: "csv text", selectedIds: ["A", "C"], savedPolicy: { auto_file_max: 100, paused: false }, previewLimit: 100 }));

  expect(html).toContain("Send 2 claims to RxSolve");
  expect(html).toContain("disabled=\"\"");
  expect(html).toContain("Claims over your saved $100.00 auto-file limit wait for your approval.");
  expect(html).not.toContain("The limit above is a preview");
  expect(html).toContain("Tick the box to confirm.");
  expect(html).not.toContain("checked=\"\"");
  expect(html).not.toContain("—");
});
