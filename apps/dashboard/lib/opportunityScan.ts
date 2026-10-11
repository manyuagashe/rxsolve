export type ScanStatus = "READY" | "PAID_FAIRLY" | "NEEDS_REVIEW" | "MISSING_DATA" | "EXPIRED";

export const MINIMUM_SCAN_DURATION_MS = 1_200;

export function remainingScanDelay(startedAt: number, now = Date.now()): number {
  return Math.max(0, MINIMUM_SCAN_DURATION_MS - (now - startedAt));
}


type StatusTone = "good" | "muted" | "warn" | "bad";

export function scanStatusPresentation(status: ScanStatus): { label: string; tone: StatusTone } {
  switch (status) {
    case "READY": return { label: "Ready for RxSolve", tone: "good" };
    case "PAID_FAIRLY": return { label: "Paid fairly", tone: "muted" };
    case "NEEDS_REVIEW": return { label: "Needs review", tone: "warn" };
    case "MISSING_DATA": return { label: "Missing evidence", tone: "warn" };
    case "EXPIRED": return { label: "Deadline expired", tone: "bad" };
  }
}

export function readyClaimIds(claims: Array<{ claim_id: string; status: ScanStatus }>): string[] {
  return claims.filter((claim) => claim.status === "READY").map((claim) => claim.claim_id);
}

export type OpportunityScanResult = {
  parser: {
    mode: "deterministic" | "llm_assisted";
    mapped_headers: Record<string, string>;
  };
  summary: {
    claims_scanned: number;
    underpaid_claims: number;
    ready_claims: number;
    needs_review_claims: number;
    missing_data_claims: number;
    expired_claims: number;
    paid_fairly_claims: number;
    total_shortfall: number;
    ready_to_recover: number;
    estimated_fee: number;
    estimated_pharmacy_net: number;
  };
  claims: Array<{
    claim_id: string;
    fill_date: string;
    ndc: string;
    drug: string;
    pbm: string;
    state: string;
    total_paid: number;
    acquisition_cost: number;
    invoice_number: string | null;
    invoice_date: string | null;
    appeal_deadline: string;
    quantity: number | null;
    rx_number: string | null;
    plan: string | null;
    shortfall: number;
    status: ScanStatus;
    reason: string;
  }>;
};

// --- Review queue and policy setup -------------------------------------------------------------
// Everything below is a preview that runs in the browser. It never stores a claim or files an appeal.

export type ScanClaim = OpportunityScanResult["claims"][number];

/** The fields the policy preview needs. Kept small so tests do not have to build a full claim. */
type QueueClaim = Pick<ScanClaim, "claim_id" | "status" | "shortfall">;

/** Same default as the API's standing authorization in apps/api/src/policy.ts. */
export const DEFAULT_AUTO_FILE_MAX = 100;

const roundMoney = (value: number) => Math.round(value * 100) / 100;
const dollars = (value: number) => `$${value.toFixed(2)}`;
const sumShortfall = (claims: readonly QueueClaim[]) => roundMoney(claims.reduce((sum, claim) => sum + claim.shortfall, 0));

/** Claims a pharmacist can act on: ready ones plus small shortfalls that need a human look. */
export function reviewQueue<T extends { status: ScanStatus }>(claims: readonly T[]): T[] {
  return claims.filter((claim) => claim.status === "READY" || claim.status === "NEEDS_REVIEW");
}

/** Adds the claim if it is not selected, removes it if it is. Returns a new array. */
export function toggleSelected(selected: readonly string[], claimId: string): string[] {
  return selected.includes(claimId) ? selected.filter((id) => id !== claimId) : [...selected, claimId];
}

/** Reads the dollar-limit text box. Returns null for anything that is not a plain non-negative amount. */
export function parseAutoFileMax(raw: string): number | null {
  const text = raw.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  return Number(text);
}

export type PolicyPreview<T extends QueueClaim> = {
  autoFile: T[];
  needsApproval: Array<{ claim: T; why: string }>;
  autoFileTotal: number;
  needsApprovalTotal: number;
  selectedTotal: number;
};

/**
 * Splits the selected claims the way the standing authorization would: inside the policy they
 * would file on their own, outside it they would wait for the pharmacist.
 */
export function previewPolicy<T extends QueueClaim>(
  claims: readonly T[],
  selectedIds: readonly string[],
  autoFileMax: number,
): PolicyPreview<T> {
  const selected = reviewQueue(claims).filter((claim) => selectedIds.includes(claim.claim_id));
  const autoFile: T[] = [];
  const needsApproval: Array<{ claim: T; why: string }> = [];

  for (const claim of selected) {
    if (claim.status === "NEEDS_REVIEW") {
      needsApproval.push({ claim, why: "Small shortfall needs pharmacist review" });
    } else if (claim.shortfall > autoFileMax) {
      needsApproval.push({ claim, why: `${dollars(claim.shortfall)} is over the ${dollars(autoFileMax)} auto-file limit` });
    } else {
      autoFile.push(claim);
    }
  }

  return {
    autoFile,
    needsApproval,
    autoFileTotal: sumShortfall(autoFile),
    needsApprovalTotal: sumShortfall(needsApproval.map((entry) => entry.claim)),
    selectedTotal: sumShortfall(selected),
  };
}

// --- Handoff to the claim pipeline -------------------------------------------------------------
// Unlike the preview above, a handoff is real: the API stores the claims and the pipeline may file
// appeals. It runs under the pharmacy's saved policy and never changes it, so the limit typed above
// stays a what-if preview.

/** Same cap as the API (apps/api/src/scan-handoff.ts). */
export const MAX_HANDOFF_CLAIMS = 25;

/** The saved standing authorization (GET /api/opportunity-scan/policy). */
export type SavedPolicy = { auto_file_max: number; paused: boolean };

export type HandoffResult = {
  policy: SavedPolicy;
  accepted: Array<{ claim_id: string; scan_shortfall: number; rxsolve_shortfall: number }>;
  rejected: Array<{ claim_id: string; reason: string }>;
};

/** Why the send button is disabled, or null when it can be pressed. */
export function handoffBlocker(input: { selectedCount: number; confirmed: boolean }): string | null {
  if (input.selectedCount === 0) return "Select at least one claim.";
  if (input.selectedCount > MAX_HANDOFF_CLAIMS) return `Send ${MAX_HANDOFF_CLAIMS} claims or fewer at a time.`;
  if (!input.confirmed) return "Tick the box to confirm.";
  return null;
}

/** The confirmation line: which limit a handoff actually runs under. */
export function handoffPolicyNote(saved: SavedPolicy | null): string {
  if (!saved) return "Claims run under your saved auto-file limit and can file real appeals.";
  if (saved.paused) return "Auto-filing is paused, so every claim will wait for your approval.";
  return `Claims over your saved ${dollars(saved.auto_file_max)} auto-file limit wait for your approval. Others can file real appeals.`;
}

/** Shown when the preview limit differs from the saved one, so the preview is not mistaken for the policy. */
export function previewMismatchNote(saved: SavedPolicy | null, previewLimit: number | null): string | null {
  if (!saved || previewLimit === null || previewLimit === saved.auto_file_max) return null;
  return `The limit above is a preview. Sending uses your saved ${dollars(saved.auto_file_max)} limit.`;
}
