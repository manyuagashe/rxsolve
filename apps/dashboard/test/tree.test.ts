import { expect, test } from "bun:test";
import type { Action, ChannelMessage, Decision, LiveEvent } from "@rxsolve/contracts";
import type { ClaimView } from "../lib/state";
import { deriveTree, formatDuration, nodeLabel, nodeStatuses, resolveReason } from "../lib/tree";

const claim = { claim_id: "RXS-1", drug: "Metformin", acquisition_cost: 10, pbm: "PBM_PORTAL" } as ClaimView["claim"];
const view = (over: Partial<ClaimView> = {}): ClaimView => ({ claim, decisions: [], actions: [], ...over });
const verdict = (over: Record<string, unknown> = {}) =>
  ({ claim_id: "RXS-1", verdict: "UNDERWATER", delta: 4, benchmark_used: "acquisition_cost", appeal_deadline: "2026-10-20", confidence: 0.97, ...over }) as ClaimView["verdict"];
const evidence = (completeness = 1) =>
  ({ claim_id: "RXS-1", statute: "TN 56-7-3105", entitlement: "", attachments: ["inv.pdf"], required_fields_present: [], spec_version: "1", completeness, fields: {}, delta: 4, appeal_deadline: null }) as ClaimView["evidence"];
const ticket = { claim_id: "RXS-1", pbm: "PBM_PORTAL", channel: "portal", ticket_id: "T1", submitted_at: "", expected_response_by: "" } as ClaimView["ticket"];
const denial = (over: Partial<Decision> = {}): Decision =>
  ({ claim_id: "RXS-1", ticket_id: "T1", status: "DENIED", reason: "missing_field", field: "wholesaler_attestation", delta: null, raw: "need attestation", ...over });
const refiled: Action = { kind: "REFILED" };

test("legacy verdict without reason falls back to the confidence proxy", () => {
  expect(resolveReason(view({ verdict: verdict() }))).toBe("underpaid");
  expect(resolveReason(view({ verdict: verdict({ confidence: 0.8 }) }))).toBe("marginal_resolved_underwater");
  expect(resolveReason(view({ verdict: verdict({ verdict: "MARGINAL", confidence: 0.5 }) }))).toBe("marginal_unresolved");
  expect(resolveReason(view({ verdict: verdict({ verdict: "CLEAR", confidence: 0.8 }) }))).toBe("marginal_resolved_clear");
  expect(resolveReason(view({ verdict: verdict({ verdict: "CLEAR", confidence: 1 }) }))).toBe("paid_at_or_above_cost");
});

test("a cleared claim takes the short path and every other branch is excluded", () => {
  const v = view({ stage: "CLEARED", verdict: verdict({ verdict: "CLEAR", delta: 0, confidence: 1, reason: "paid_at_or_above_cost" }) });
  const m = deriveTree(v, [], [], 0);
  expect(m.path.map((p) => p.node)).toEqual(["received", "verdict", "clear"]);
  const s = nodeStatuses(m);
  expect(s.underwater).toBe("excluded");
  expect(s.evidence).toBe("excluded");
  expect(m.active).toBeNull();
});

test("a marginal claim the agent escalates to appeal walks both marginal and underwater", () => {
  const v = view({ stage: "FILED", verdict: verdict({ confidence: 0.8, reason: "marginal_resolved_underwater" }), evidence: evidence(), ticket });
  const m = deriveTree(v, [], [], 0);
  expect(m.path.map((p) => p.node).slice(0, 5)).toEqual(["received", "verdict", "marginal", "m_appeal", "underwater"]);
  expect(m.active).toBe("decision_1");
});

test("incomplete evidence stops at the exception and never reaches the door", () => {
  const v = view({ stage: "EXCEPTION", reason: "incomplete_evidence", verdict: verdict({ reason: "underpaid" }), evidence: evidence(0.5) });
  const m = deriveTree(v, [], [], 0);
  expect(m.taken.has("ex_incomplete")).toBe(true);
  expect(m.taken.has("door")).toBe(false);
  expect(nodeStatuses(m).ex_policy).toBe("excluded");
});

test("a missing-field denial then approval loops through remediation and settles", () => {
  const v = view({
    stage: "SETTLED", verdict: verdict({ reason: "underpaid" }), evidence: evidence(), ticket,
    decisions: [denial(), { ...denial(), status: "APPROVED", reason: null, field: null, delta: 4, raw: null }],
    actions: [refiled],
  });
  const m = deriveTree(v, [], [], 0);
  const nodes = m.path.map((p) => p.node);
  expect(nodes).toContain("denied_1");
  expect(nodes).toContain("missing_field_1");
  expect(nodes).toContain("refile_mf_1");
  expect(nodes).toContain("approved_2");
  expect(nodes).not.toContain("approved_1");
  expect(nodes.at(-1)).toBe("settled");
  expect(m.rounds).toHaveLength(1);
  const st = nodeStatuses(m);
  expect(st.denied_1).toBe("taken");
  expect(st.approved_1).toBe("excluded");
  expect(st.approved_2).toBe("taken");
  expect(st.denied_2).toBe("excluded");
  expect(m.path.map((p) => p.text)).toContain("Round 1: PBM denied, missing signed statement from the wholesaler");
  expect(m.path.map((p) => p.text)).toContain("Round 2: PBM approved the appeal");
});

test("phone branch appears only when a phone message exists", () => {
  const base = view({
    stage: "ESCALATED", reason: "rep denied by phone, supervisor review", verdict: verdict({ reason: "underpaid" }), evidence: evidence(), ticket,
    decisions: [denial({ reason: "disputed", field: null }), denial({ reason: "disputed", field: null })],
    actions: [refiled, { kind: "ESCALATED", reason: "rep denied by phone, supervisor review" }],
  });
  expect(deriveTree(base, [], [], 0).taken.has("phone_2")).toBe(false);
  const call = { claim_id: "RXS-1", channel: "phone", direction: "out", counterparty: "PBM_PORTAL", text: "hi", attachments: [], audio_url: null, meta: {}, ts: "" } as ChannelMessage;
  const m = deriveTree(base, [call], [], 0);
  expect(m.taken.has("phone_2")).toBe(true);
  expect(m.taken.has("dispute_escalated_2")).toBe(true);
});

test("too many rounds and no reply are distinct escalation leaves", () => {
  const filed = { verdict: verdict({ reason: "underpaid" }), evidence: evidence(), ticket };
  expect(deriveTree(view({ ...filed, stage: "ESCALATED", reason: "too many denial rounds" }), [], [], 0).taken.has("too_many_1")).toBe(true);
  expect(deriveTree(view({ ...filed, stage: "ESCALATED", reason: "no response before deadline" }), [], [], 0).taken.has("noreply_1")).toBe(true);
});

test("step timings split our work from outside waiting", () => {
  const ev = (type: string, ts: string, payload: unknown = {}): LiveEvent =>
    ({ type, ts, claim_id: "RXS-1", payload }) as LiveEvent;
  const log = [
    ev("claim.received", "2026-10-11T10:00:00.000Z"),
    ev("verdict", "2026-10-11T10:00:00.200Z"),
    ev("evidence.built", "2026-10-11T10:00:02.200Z"),
    ev("appeal.filed", "2026-10-11T10:00:04.200Z"),
  ];
  const v = view({ stage: "FILED", verdict: verdict({ reason: "underpaid" }), evidence: evidence(), ticket });
  const now = Date.parse("2026-10-11T10:00:14.200Z");
  const m = deriveTree(v, [], log, now);
  expect(m.ourMs).toBe(4200);
  expect(m.outsideMs).toBe(10_000);
  expect(m.active).toBe("decision_1");
  expect(formatDuration(m.outsideMs)).toBe("10s");
});

test("the tree grows one round at a time and the open round shows a fork", () => {
  const base = { verdict: verdict({ reason: "underpaid" }), evidence: evidence(), ticket };
  const inFlight = deriveTree(view({ ...base, stage: "FILED" }), [], [], 0);
  const ids = (n: { id: string; children?: unknown[] }): string[] => [n.id, ...((n.children ?? []) as { id: string; children?: unknown[] }[]).flatMap(ids)];
  expect(ids(inFlight.tree)).toContain("decision_1");
  expect(ids(inFlight.tree)).not.toContain("decision_2");
  expect(inFlight.active).toBe("decision_1");
  const round2 = deriveTree(view({ ...base, stage: "FILED", decisions: [denial()], actions: [refiled] }), [], [], 0);
  expect(ids(round2.tree)).toContain("decision_2");
  expect(round2.active).toBe("decision_2");
  expect(nodeStatuses(round2).decision_1).toBe("taken");
  expect(nodeStatuses(round2).denied_1).toBe("taken");
  expect(nodeStatuses(round2).approved_1).toBe("excluded");
});

test("no door taken before filing and the fork is active", () => {
  const m = deriveTree(view({ stage: "EVIDENCE", verdict: verdict({ reason: "underpaid" }), evidence: evidence() }), [], [], 0);
  expect(m.active).toBe("door");
  expect(m.taken.has("door_portal") || m.taken.has("door_email") || m.taken.has("door_fax")).toBe(false);
});

test("the door used is taken and continues into the decision; the others are excluded", () => {
  const fax = { ...ticket, channel: "fax" } as ClaimView["ticket"];
  const m = deriveTree(view({ stage: "FILED", verdict: verdict({ reason: "underpaid" }), evidence: evidence(), ticket: fax }), [], [], 0);
  const st = nodeStatuses(m);
  expect(st.door_fax).toBe("taken");
  expect(st.door_portal).toBe("excluded");
  expect(m.taken.has("door_portal")).toBe(false);
  expect(m.active).toBe("decision_1");
});

test("missing-field node labels name the actual item once the denial says which", () => {
  const d = (field: string | null) => ({ claim_id: "C", ticket_id: "T", status: "DENIED", reason: "missing_field", field, delta: null, raw: null }) as never;
  expect(nodeLabel("missing_field_1", "Missing paper: ask the wholesaler for it", [{ n: 1, decision: d("invoice_date") }]))
    .toBe("Missing invoice date: ask the wholesaler for it");
  expect(nodeLabel("refile_mf_1", "File again with the missing paper", [{ n: 1, decision: d("invoice_number") }]))
    .toBe("File again with the invoice number");
  expect(nodeLabel("missing_field_2", "Missing paper: ask the wholesaler for it", [{ n: 1, decision: d("invoice_date") }]))
    .toBe("Missing paper: ask the wholesaler for it");
  expect(nodeLabel("disputed_1", "Disputed", [{ n: 1, decision: d(null) }])).toBe("Disputed");
});
