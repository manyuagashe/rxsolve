/** Derives the per-claim status tree (path, rounds, step timings) from live state. Owner: P3. Pure. */
import type { Action, ChannelMessage, Decision, LiveEvent, VerdictReason } from "@rxsolve/contracts";
import type { ClaimView } from "./state";
import { type Actor, NODE_BY_ID, type NodeId, rid, splitRid, STEP_ACTOR, type StepKind, TREE, type TreeNode, treeFor } from "./treeShape";
import { roundAnchor } from "./treeLayout";
import { plainField, plainReason } from "./plain";

export type NodeStatus = "taken" | "active" | "excluded" | "pending";
export type PathEntry = { node: NodeId; text: string; inFlight: boolean };

export type Round = {
  n: number;
  decision: Decision;
  action?: Action;
  /** Nodes this denial round walked through, in order. */
  nodes: NodeId[];
};

export type Step = { kind: StepKind; node: NodeId; actor: Actor; start: number; end: number | null };

export type TreeModel = {
  claimId: string;
  taken: Set<NodeId>;
  active: NodeId | null;
  path: PathEntry[];
  rounds: Round[];
  phone: ChannelMessage[];
  wholesaler: ChannelMessage[];
  details: Partial<Record<NodeId, string>>;
  door: string | null;
  /** True once the orchestrator has stopped and nothing further will happen on its own. */
  ended: boolean;
  steps: Step[];
  nodeMs: Partial<Record<NodeId, number>>;
  /** The tree drawn for this claim: static fork plus the rounds it has reached. */
  tree: TreeNode;
  ourMs: number;
  outsideMs: number;
  /** Timestamp the active node started waiting, when the log still has it. */
  activeSince: number | null;
  activeActor: Actor | null;
};

const END_STAGES = new Set(["CLEARED", "SETTLED", "ESCALATED", "ABANDONED"]);
const usd = (n: number | null | undefined) => `$${(n ?? 0).toFixed(2)}`;

/** The verdict reason, falling back to the confidence stamped on each branch. */
export function resolveReason(view: ClaimView): VerdictReason | undefined {
  const v = view.verdict;
  if (!v) return undefined;
  if (v.reason) return v.reason;
  const agentResolved = v.confidence > 0.6 && v.confidence < 0.9;
  if (v.verdict === "MARGINAL") return "marginal_unresolved";
  if (v.verdict === "UNDERWATER") return agentResolved ? "marginal_resolved_underwater" : "underpaid";
  if (agentResolved) return "marginal_resolved_clear";
  return view.claim.acquisition_cost === null ? "no_invoice" : "paid_at_or_above_cost";
}


const VERDICT_WORD: Record<string, string> = { UNDERWATER: "underpaid", MARGINAL: "borderline", CLEAR: "paid fairly" };

/** The one place the numbers are stated: what was paid against the drug cost. */
function factsLine(view: ClaimView): string {
  const { paid_amount: paid, acquisition_cost: cost } = view.claim;
  if (cost === null || cost === undefined) return "No invoice on file, so there is no drug cost to compare against";
  const gap = cost - paid;
  return `Paid ${usd(paid)} against a drug cost of ${usd(cost)}${gap > 0 ? `, ${usd(gap)} short` : ""}`;
}

function exceptionNode(view: ClaimView): NodeId {
  if (view.reason === "marginal" || view.verdict?.verdict === "MARGINAL") return "m_unavailable";
  if (view.reason === "incomplete_evidence") return "ex_incomplete";
  return "ex_policy";
}

export function deriveTree(
  view: ClaimView, messages: readonly ChannelMessage[], log: readonly LiveEvent[], now: number,
): TreeModel {
  const claimId = view.claim.claim_id;
  const path: PathEntry[] = [];
  const taken = new Set<NodeId>();
  const details: Partial<Record<NodeId, string>> = {};
  const add = (node: NodeId, text: string) => {
    if (!taken.has(node)) taken.add(node);
    path.push({ node, text, inFlight: false });
  };

  const mine = messages.filter((m) => m.claim_id === claimId);
  const wholesaler = mine.filter((m) => m.counterparty === "wholesaler");
  const phone = mine.filter((m) => m.channel === "phone");
  const stage = view.stage;
  const reason = resolveReason(view);
  const ended = stage !== undefined && (END_STAGES.has(stage) || stage === "EXCEPTION");
  let active: NodeId | null = null;

  add("received", "Claim received");
  const arrived = log.find((e) => e.type === "claim.received" && e.claim_id === claimId);
  const at = arrived ? new Date(arrived.ts) : null;
  details.received = `Paid ${usd(view.claim.paid_amount)} by the PBM${at && !Number.isNaN(at.getTime()) ? `, arrived ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`;

  const v = view.verdict;
  if (!v) {
    if (stage === "ABANDONED" && view.reason === "no_ledger_account") add("intake_rejected", "Given up at intake: no ledger account");
    else if (!ended) active = "verdict";
  } else {
    details.verdict = factsLine(view);
    add("verdict", `Underpayment check: ${VERDICT_WORD[v.verdict] ?? v.verdict}`);
    if (reason === "no_invoice" || reason === "paid_at_or_above_cost") add("clear", "Paid fairly, no recovery needed");
    if (reason === "marginal_resolved_clear") { add("marginal", "Borderline"); add("m_immaterial", "Agent judged it not worth appealing"); }
    if (reason === "marginal_unresolved") { add("marginal", "Borderline"); add("m_unavailable", "Agent unavailable, the pharmacist decides"); }
    if (reason === "marginal_resolved_underwater") { add("marginal", "Borderline"); add("m_appeal", "Agent judged it worth appealing"); }
    if (v.verdict === "UNDERWATER") add("underwater", "Continues as underpaid");
  }

  const underwater = v?.verdict === "UNDERWATER";
  const exception = stage === "EXCEPTION" ? exceptionNode(view) : null;
  const ev = view.evidence;
  const denied = view.decisions.filter((d) => d.status === "DENIED");
  const approved = view.decisions.some((d) => d.status === "APPROVED");
  const rounds: Round[] = [];
  const doorChannel = view.ticket?.channel ?? null;

  if (underwater) {
    if (!ev) {
      if (!ended) active = "evidence";
    } else {
      details.evidence = `${Math.round(ev.completeness * 100)}% complete, ${ev.attachments.length} attachment${ev.attachments.length === 1 ? "" : "s"}, ${ev.statute}`;
      add("evidence", "Proof built");
    }
    if (ev && !view.ticket && !ended) active = "door";
    if (view.ticket) {
      add("door", "Chose how to file");
      const doorNode = `door_${view.ticket.channel}` as NodeId;
      if (NODE_BY_ID[doorNode]) add(doorNode, `Door: ${view.ticket.channel}`);
      let disputes = 0;
      let phoneUsed = false;
      const settledRound = denied.length + 1;
      view.decisions.forEach((_, j) => taken.add(rid("decision", j + 1)));
      if (view.decisions.length === 0) taken.add(rid("decision", 1));
      denied.forEach((decision, i) => {
        const n = i + 1;
        const action = view.actions[i];
        const nodes: NodeId[] = [rid("denied", n)];
        const external = action?.kind === "EXTERNAL_APPEAL";
        if (decision.reason === "missing_field" && !external) nodes.push(rid("missing_field", n));
        if (decision.reason === "disputed" && !external) {
          const second = disputes > 0;
          disputes++;
          if (!second) nodes.push(rid("disputed", n));
          else if (phone.length > 0 && !phoneUsed) { phoneUsed = true; nodes.push(rid("phone", n)); }
          else if (!action) nodes.push(rid("disputed", n));
        }
        if (action?.kind === "REFILED") {
          if (decision.reason === "missing_field") nodes.push(rid("refile_mf", n));
          else if (decision.reason === "disputed" && !nodes.includes(rid("phone", n))) nodes.push(rid("refile_rebut", n));
        }
        if (action?.kind === "ESCALATED") nodes.push(rid("dispute_escalated", n));
        if (action?.kind === "EXTERNAL_APPEAL") nodes.push(rid("window_closed", n));
        if (action?.kind === "ABANDONED") nodes.push(rid("unrecoverable", n));
        rounds.push({ n, decision, action, nodes });
        for (const node of nodes) add(node, pathText(node, decision, action, n));
      });
      if (approved) {
        add(rid("approved", settledRound), `Round ${settledRound}: PBM approved the appeal`);
        add("settle", "Paid out on the ledger");
        if (stage === "SETTLED") add("settled", "Recovered");
      }
      const openRound = denied.length + 1;
      if (stage === "ESCALATED" && view.reason === "no response before deadline") add(rid("noreply", openRound), `Round ${openRound}: no PBM reply before the deadline, escalated`);
      if (stage === "ESCALATED" && view.reason === "too many denial rounds") add(rid("too_many", Math.max(1, denied.length)), "Too many denial rounds, escalated");

      if (!ended) {
        const waitingOnAction = denied.length > view.actions.length;
        const lastNodes = rounds.at(-1)?.nodes ?? [];
        if (approved) active = "settle";
        else if (waitingOnAction) active = lastNodes.filter((n) => !n.startsWith("denied")).at(-1) ?? lastNodes[0] ?? rid("denied", denied.length);
        else active = rid("decision", openRound);
      }
    }
  }
  if (exception) {
    if (!taken.has(exception)) {
      details[exception] = view.reason ? plainReason(view.reason) : "";
      add(exception, exception === "ex_incomplete" ? "Needs you: proof incomplete, nothing filed" : "Needs you: outside the pharmacist's standing rules");
    }
    active = exception;
  }
  if (underwater && !approved && stage === "SETTLED") add("settled", "Recovered");
  if (active) {
    if (!taken.has(active)) path.push({ node: active, text: pathText(active), inFlight: true });
    else {
      const idx = path.findLastIndex((p) => p.node === active);
      if (idx >= 0) path[idx] = { ...path[idx]!, inFlight: true };
    }
    taken.add(active);
  }
  const shape = doorChannel
    ? {
        approvedRound: approved ? denied.length + 1 : stage === "SETTLED" ? Math.max(1, view.decisions.length) : null,
        count: Math.min(3, Math.max(1, approved ? view.decisions.length
          : denied.length + (view.actions[denied.length - 1]?.kind === "REFILED" ? 1 : 0))),
        anchors: rounds.map((rd) => roundAnchor(rd)),
      }
    : null;
  const tree = treeFor(doorChannel, shape);
  for (const id of [...taken]) for (const a of ancestors(id, tree)) taken.add(a);

  const door = doorChannel;
  const steps = buildSteps(claimId, log, rounds, view, active);
  const nodeMs: Partial<Record<NodeId, number>> = {};
  let ourMs = 0;
  let outsideMs = 0;
  for (const s of steps) {
    const ms = Math.max(0, (s.end ?? now) - s.start);
    nodeMs[s.node] = (nodeMs[s.node] ?? 0) + ms;
    if (s.actor === "external") outsideMs += ms;
    else ourMs += ms;
  }
  const open = steps.find((s) => s.end === null);
  return {
    claimId, taken, active, path, rounds, phone, wholesaler, details, door, ended, steps, nodeMs, tree,
    ourMs, outsideMs, activeSince: open?.start ?? null, activeActor: open?.actor ?? null,
  };
}

/** Card label for a node: the missing-field steps name the actual missing item once the PBM's denial said which. */
export function nodeLabel(id: NodeId, label: string, rounds: readonly { n: number; decision: Decision }[]): string {
  const parts = splitRid(id);
  if (!parts || (parts.base !== "missing_field" && parts.base !== "refile_mf")) return label;
  const field = rounds.find((r) => r.n === parts.n)?.decision.field;
  if (!field) return label;
  const what = plainField(field);
  return parts.base === "missing_field" ? `Missing ${what}: ask the wholesaler for it` : `File again with the ${what}`;
}

function pathText(node: NodeId, decision?: Decision, action?: Action, n?: number): string {
  const parts = splitRid(node);
  const base = parts?.base ?? node;
  const round = parts?.n ?? n;
  const r = round !== undefined ? `Round ${round}: ` : "";
  switch (base) {
    case "denied": {
      const why = decision?.field ? `missing ${plainField(decision.field)}` : decision?.reason ? plainReason(decision.reason) : "";
      return `${r}PBM denied${why ? `, ${why}` : ""}`;
    }
    case "approved": return `${r}PBM approved the appeal`;
    case "missing_field": return `${r}Asked the wholesaler for the ${decision?.field ? plainField(decision.field) : "missing paper"}`;
    case "refile_mf": return `${r}Filed again with the missing paper`;
    case "disputed": return `${r}Sent a written reply`;
    case "refile_rebut": return `${r}Filed again with the reply`;
    case "phone": return `${r}Called the PBM rep`;
    case "dispute_escalated": return `${r}Still disputed, escalated to a supervisor${action?.reason ? `: ${action.reason}` : ""}`;
    case "unrecoverable": return `${r}Given up${action?.reason ? `: ${action.reason}` : ""}`;
    case "window_closed": return `${r}Appeal window closed, sent to an outside appeal${action?.reason ? `: ${action.reason}` : ""}`;
    case "evidence": return "Building the proof";
    case "door": return "Choosing how to file";
    case "decision": return `${r}Waiting for the PBM's decision`;
    case "settle": return "Paying out on the ledger";
    case "verdict": return "Checking whether it was underpaid";
    default: return NODE_BY_ID[node]?.label ?? node;
  }
}

const parentMap = (root: TreeNode): Record<string, NodeId> => {
  const out: Record<string, NodeId> = {};
  (function index(n: TreeNode) {
    for (const c of n.children ?? []) { out[c.id] = n.id; index(c); }
  })(root);
  return out;
};

export function ancestors(id: NodeId, tree: TreeNode): NodeId[] {
  const parents = parentMap(tree);
  const out: NodeId[] = [];
  let cur: NodeId | undefined = parents[id];
  while (cur) { out.push(cur); cur = parents[cur]; }
  return out;
}

/** Splits each log interval of one claim into who was working during it. */
function buildSteps(
  claimId: string, log: readonly LiveEvent[], rounds: Round[], view: ClaimView, active: NodeId | null,
): Step[] {
  const events = log.filter((e) => e.claim_id === claimId);
  const first = events.find((e) => e.type === "claim.received");
  if (!first) return [];
  const steps: Step[] = [];
  let cursor = Date.parse(first.ts);
  let denialIdx = 0;
  const push = (kind: StepKind, node: NodeId, end: number, actor: Actor = STEP_ACTOR[kind]) => {
    if (Number.isFinite(end)) { steps.push({ kind, node, actor, start: cursor, end }); cursor = Math.max(cursor, end); }
  };
  const branchOf = (i: number): NodeId => rounds[i]?.nodes.filter((n) => !n.startsWith("denied") && !n.startsWith("refile"))[0] ?? rid("denied", i + 1);
  let decisionsSeen = 0;
  const marginal = view.verdict ? (resolveReason(view) ?? "").startsWith("marginal") : false;
  let sinceDecision: LiveEvent[] = [];

  for (const e of events) {
    const t = Date.parse(e.ts);
    switch (e.type) {
      case "verdict": push(marginal ? "verdict_agent" : "verdict", "verdict", t); break;
      case "evidence.built": push("evidence", "evidence", t); break;
      case "appeal.filed": push("filing", "door", t); break;
      case "appeal.decision":
        push("pbm_wait", rid("decision", decisionsSeen + 1), t);
        decisionsSeen++;
        sinceDecision = [];
        break;
      case "channel.message": sinceDecision.push(e); break;
      case "negotiation.action": {
        const node = branchOf(denialIdx);
        const ws = sinceDecision.filter((m) => m.type === "channel.message" && m.payload.counterparty === "wholesaler");
        const ph = sinceDecision.filter((m) => m.type === "channel.message" && m.payload.channel === "phone");
        const outside = ws.length ? ws : ph;
        if (outside.length) {
          const startAt = Date.parse(outside[0]!.ts);
          const lastIn = [...outside].reverse().find((m) => m.type === "channel.message" && m.payload.direction === "in");
          const stopAt = lastIn ? Date.parse(lastIn.ts) : t;
          push("diagnose", node, startAt);
          push(ws.length ? "wholesaler_wait" : "phone_call", ws.length ? node : rid("phone", denialIdx + 1), stopAt);
          push("refile", node, t);
        } else push("diagnose", node, t);
        denialIdx++;
        break;
      }
      case "ledger.settled": push("ledger", "settle", t); break;
      case "claim.stage": {
        const s = e.payload.stage;
        if (s === "ESCALATED" && e.payload.reason === "no response before deadline") push("pbm_wait", rid("noreply", decisionsSeen + 1), t);
        else if (s === "EXCEPTION") push("gate", exceptionNode(view), t);
        else if (s === "CLEARED" || s === "SETTLED" || s === "ESCALATED" || s === "ABANDONED") push("terminal", terminalNode(view, s), t);
        break;
      }
    }
  }

  // The step still in progress runs from the last completed event until now.
  if (active && view.stage !== "CLEARED") {
    const lastMsg = sinceDecision.at(-1);
    let kind: StepKind;
    let node: NodeId = active;
    if (active === "verdict") kind = marginal ? "verdict_agent" : "verdict";
    else if (active === "evidence") kind = "evidence";
    else if (active === "door") kind = "filing";
    else if (active.startsWith("decision_")) kind = "pbm_wait";
    else if (active === "settle") kind = "ledger";
    else if (view.stage === "EXCEPTION") kind = "pharmacist";
    else if (lastMsg && lastMsg.type === "channel.message" && lastMsg.payload.channel === "phone") { kind = "phone_call"; node = rid("phone", Math.max(1, rounds.length)); }
    else if (lastMsg && lastMsg.type === "channel.message" && lastMsg.payload.counterparty === "wholesaler" && lastMsg.payload.direction === "out") kind = "wholesaler_wait";
    else kind = "diagnose";
    steps.push({ kind, node, actor: STEP_ACTOR[kind], start: cursor, end: null });
  } else if (view.stage === "EXCEPTION") {
    steps.push({ kind: "pharmacist", node: exceptionNode(view), actor: STEP_ACTOR.pharmacist, start: cursor, end: null });
  }
  return steps;
}

function terminalNode(view: ClaimView, stage: string): NodeId {
  if (stage === "CLEARED") {
    const r = resolveReason(view);
    return r === "marginal_resolved_clear" ? "m_immaterial" : "clear";
  }
  if (stage === "SETTLED") return "settled";
  const n = Math.max(1, view.decisions.filter((d) => d.status === "DENIED").length);
  if (stage === "ABANDONED") return view.verdict ? rid("unrecoverable", n) : "intake_rejected";
  if (view.reason === "too many denial rounds") return rid("too_many", n);
  return rid("dispute_escalated", n);
}

/** Status of one static node, given what the claim took. */
export function nodeStatuses(model: TreeModel): Record<string, NodeStatus> {
  const out: Record<string, NodeStatus> = {};
  const unknown = model.taken.size <= 1 && model.active === null && !model.ended;
  const visit = (n: TreeNode, parentExcluded: boolean, siblingTaken: boolean) => {
    const isTaken = model.taken.has(n.id);
    let status: NodeStatus;
    if (n.id === model.active) status = "active";
    else if (isTaken) status = "taken";
    else if (parentExcluded || (!unknown && (model.ended || siblingTaken))) status = "excluded";
    else status = "pending";
    out[n.id] = status;
    const kids = n.children ?? [];
    const anyTaken = kids.some((k) => model.taken.has(k.id));
    for (const k of kids) visit(k, status === "excluded", anyTaken);
  };
  visit(model.tree, false, false);
  return out;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
