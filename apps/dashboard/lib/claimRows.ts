/** Claim rows for the RxSolve home list: every claim in the live feed, newest first. Owner: P3. Pure. */
import type { LiveEvent, Stage } from "@rxsolve/contracts";
import { type Tone, stageTone } from "./claims";
import { stageLabel } from "./plain";
import type { ClaimView, LiveState } from "./state";

export type ClaimRow = {
  claimId: string;
  drug: string;
  qty: number | null;
  pbm: string | null;
  at: number | null;
  /** 1-based fill number among rows with the same drug, quantity and PBM; null when unique. */
  ordinal: number | null;
  pill: { label: string; tone: Tone };
  /** Underpaid amount, or null when the claim was paid at cost or has no verdict yet. */
  delta: number | null;
  paidAtCost: boolean;
  deadline: string | null;
  settled: boolean;
  quiet: boolean;
  /** Detected, proof built, filed, PBM decision, paid: lit hexes in the row's progress strip. */
  progress: [boolean, boolean, boolean, boolean, boolean];
  /** Time of this claim's latest event, so the row can flash when something new happens. */
  touched: number | null;
};

export const prettyPbm = (pbm: string) =>
  pbm.toLowerCase().split("_").map((w) => (w.length <= 3 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1))).join(" ");

export function relativeTime(at: number | null, now: number): string {
  if (at === null || !Number.isFinite(at)) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

const receivedAt = (log: readonly LiveEvent[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const e of log) if (e.type === "claim.received" && e.claim_id && !(e.claim_id in out)) out[e.claim_id] = Date.parse(e.ts);
  return out;
};

const lastTouched = (log: readonly LiveEvent[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const e of log) if (e.claim_id) out[e.claim_id] = Date.parse(e.ts);
  return out;
};

const progressOf = (v: ClaimView): ClaimRow["progress"] => [
  v.verdict?.verdict === "UNDERWATER" || (v.stage !== undefined && v.stage !== "CLEARED"),
  v.evidence !== undefined,
  v.ticket !== undefined,
  v.decisions.length > 0,
  v.stage === "SETTLED",
];

const isClear = (v: ClaimView) => v.verdict?.verdict === "CLEAR" || v.stage === "CLEARED";

export function buildClaimRows(live: Pick<LiveState, "claims" | "order" | "log">): ClaimRow[] {
  const times = receivedAt(live.log);
  const touched = lastTouched(live.log);
  const ids = [...new Set([...live.order, ...Object.keys(live.claims)])];
  const rows: ClaimRow[] = ids.flatMap((claimId) => {
    const view = live.claims[claimId];
    if (!view) return [];
    const clear = isClear(view);
    const stage: Stage | undefined = view.stage;
    const d = view.verdict?.delta ?? 0;
    return [{
      claimId,
      at: times[claimId] ?? null,
      ordinal: null,
      qty: view.claim.qty ?? null,
      pbm: view.claim.pbm ?? null,
      drug: view.claim.drug || "Drug unavailable",
      pill: { label: (stage ? stageLabel(stage) : view.verdict ? (clear ? "Paid fairly" : "Underpaid") : "Pending").toUpperCase(), tone: (clear ? "muted" : stageTone(stage)) as Tone },
      delta: !clear && d > 0 ? d : null,
      paidAtCost: clear,
      deadline: view.verdict?.appeal_deadline ?? null,
      settled: stage === "SETTLED",
      quiet: clear,
      progress: progressOf(view),
      touched: touched[claimId] ?? null,
    }];
  });
  rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const key = (r: ClaimRow) => `${r.drug}|${r.qty}|${r.pbm}`;
  const groups = new Map<string, ClaimRow[]>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  for (const g of groups.values()) if (g.length > 1) g.forEach((r, i) => { r.ordinal = g.length - i; });
  return rows;
}

/** Visible one-line summary and the link's accessible name; neither contains an id. */
export function rowSummary(r: ClaimRow, now: number): { summary: string; label: string } {
  const parts = [
    r.qty !== null ? `qty ${r.qty}` : null,
    r.pbm ? prettyPbm(r.pbm) : null,
    relativeTime(r.at, now) || null,
    r.ordinal ? `fill ${r.ordinal}` : null,
  ].filter(Boolean) as string[];
  return { summary: parts.join(" · "), label: `${r.drug}, ${parts.join(", ")}` };
}
