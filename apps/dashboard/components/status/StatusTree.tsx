"use client";
/** Static decision tree for one claim: path taken highlighted, other branches dimmed. Owner: P3. */
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import type { ClaimView } from "@/lib/state";
import { formatDuration, type NodeStatus, type TreeModel } from "@/lib/tree";
import { ACTOR_LABEL, type NodeId, splitRid, type TreeNode } from "@/lib/treeShape";
import { plainAction, plainField, plainReason } from "@/lib/plain";
import { forkOf, stackExtent } from "@/lib/treeLayout";
import { fitPopover } from "./popover";
import { DeliveryChip } from "./ExchangePanel";
import { groupExchange } from "@/lib/exchangeSteps";
import { usd } from "@/components/panels/types";
import type { ArtifactItem } from "@/lib/artifacts";
import { ArtifactsDrawer } from "./ArtifactsDrawer";

const CHIP_SLOT = 40;
const LINK_STUB = 17;
const STATUS_WORD: Record<NodeStatus, string> = {
  taken: "taken", active: "in progress", excluded: "not taken", pending: "not reached yet",
};
const shorten = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n)}...` : s);

type Props = {
  model: TreeModel;
  statuses: Record<string, NodeStatus>;
  view: ClaimView;
  now: number;
  artifacts?: Partial<Record<NodeId, ArtifactItem[]>>;
};

export function StatusTree(props: Props) {
  const { model } = props;
  const root = model.tree;
  const ext = stackExtent(root, props.statuses, model.rounds[0]?.nodes ?? []);
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const links = useRef<SVGSVGElement>(null);

  // Draws each parent-to-child link from measured centres, so geometry never depends on card heights.
  useLayoutEffect(() => {
    const box = canvas.current;
    const svg = links.current;
    if (!box || !svg) return;
    let raf = 0;
    const draw = () => {
      const cb = box.getBoundingClientRect();
      svg.setAttribute("width", String(cb.width));
      svg.setAttribute("height", String(cb.height));
      const els = [...box.querySelectorAll<HTMLElement>("[data-nid]")];
      const byId = new Map(els.map((e) => [e.dataset.nid!, e]));
      const paths: { d: string; cls: string }[] = [];
      for (const el of els) {
        const parent = el.dataset.parent ? byId.get(el.dataset.parent) : undefined;
        if (!parent) continue;
        const p = parent.getBoundingClientRect();
        const c = el.getBoundingClientRect();
        const x1 = p.right - cb.left;
        const y1 = p.top + p.height / 2 - cb.top;
        const x2 = c.left - cb.left;
        const y2 = c.top + c.height / 2 - cb.top;
        const xs = x2 - LINK_STUB;
        const state = el.dataset.state;
        const cls = state === "active" ? "link--active" : state === "taken" ? "link--taken" : "link--dim";
        paths.push({ d: Math.abs(y2 - y1) < 0.5 ? `M${x1} ${y1}H${x2}` : `M${x1} ${y1}H${xs}V${y2}H${x2}`, cls });
      }
      paths.sort((a, b) => Number(a.cls !== "link--dim") - Number(b.cls !== "link--dim"));
      const markup = paths.map((p) => `<path class="${p.cls}" d="${p.d}"/>`).join("");
      if (svg.dataset.markup !== markup) { svg.dataset.markup = markup; svg.innerHTML = markup; }
    };
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); };
    draw();
    const mo = new MutationObserver(schedule);
    mo.observe(box, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "data-state", "aria-expanded"] });
    const ro = new ResizeObserver(schedule);
    ro.observe(box);
    document.fonts?.ready.then(schedule).catch(() => {});
    return () => { cancelAnimationFrame(raf); mo.disconnect(); ro.disconnect(); };
  });
  const activeKey = `${model.active ?? ""}:${model.rounds.length}`;

  // Keeps the active node in view on load and whenever it moves; smooth only without reduced motion.
  useEffect(() => {
    const box = scroller.current;
    const el = box?.querySelector<HTMLElement>('[aria-current="step"] > .tnode__card');
    if (!box || !el || box.scrollWidth <= box.clientWidth) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const b = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    // Starts at the left; moves only as far as needed to keep the active card fully visible.
    let delta = 0;
    if (r.right > b.right - 24) delta = r.right - b.right + 48;
    else if (r.left < b.left + 8) delta = r.left - b.left - 24;
    if (delta !== 0) box.scrollTo({ left: Math.max(0, box.scrollLeft + delta), behavior: reduced ? "auto" : "smooth" });
  }, [activeKey]);

  const by = (dir: number) => {
    const box = scroller.current;
    if (!box) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.scrollBy({ left: dir * box.clientWidth * 0.6, behavior: reduced ? "auto" : "smooth" });
  };

  return (
    <div className="tree-wrap">
      <div className="tree-nav">
        <button type="button" onClick={() => by(-1)} aria-label="Scroll the tree left"><ArrowLeft aria-hidden="true" /></button>
        <button type="button" onClick={() => by(1)} aria-label="Scroll the tree right"><ArrowRight aria-hidden="true" /></button>
      </div>
      <div className="tree-scroll" ref={scroller} tabIndex={0} role="region" aria-label="Decision tree, scrolls sideways">
        <div className="tree-canvas" ref={canvas}>
          <svg className="tree-links" ref={links} aria-hidden="true" />
          <ol className="tree tree--root" aria-label="Decision tree" style={{ paddingTop: ext.above * CHIP_SLOT + 8, paddingBottom: ext.below * CHIP_SLOT + 8 }}>
            <Node node={root} {...props} />
          </ol>
        </div>
      </div>
    </div>
  );
}

function Chip({ node, status, parent }: { node: TreeNode; status: NodeStatus; parent: NodeId }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`tnode tnode--chip tnode--${status}${open ? " tnode--chip-open" : ""}`}>
      <button type="button" className="tchip" data-nid={node.id} data-parent={parent} data-state={status} aria-expanded={open} title={node.label} onClick={() => setOpen((o) => !o)}>
        <span className="tnode__marker" aria-hidden="true" />
        <span className="tchip__text">{node.label}</span>
        <span className="sr-only"> ({STATUS_WORD[status]})</span>
      </button>
    </li>
  );
}

type Sibs = { parent: NodeId; above: TreeNode[]; below: TreeNode[] };

function Node({ node, model, statuses, view, now, artifacts, sibs }: Props & { node: TreeNode; sibs?: Sibs }) {
  const status = statuses[node.id] ?? "pending";
  const ms = model.nodeMs[node.id];
  const isActive = status === "active";
  const elapsed = isActive && model.activeSince !== null ? now - model.activeSince : null;
  const detail = model.details[node.id];
  const end = node.end && status !== "excluded" ? ` tnode--end-${node.end}` : "";
  const fork = forkOf(node.children ?? [], statuses, model.rounds[0]?.nodes ?? []);
  const rest = fork.main ? [] : fork.chips;
  const shared = { model, statuses, view, now, artifacts };
  // Taken siblings other than the main one stay on the path as lit chips; their detail lives in the round chains.
  const chipFor = (parent: NodeId) => (c: TreeNode) => <Chip key={c.id} node={c} status={statuses[c.id] ?? "pending"} parent={parent} />;

  return (
    <li className={`tnode tnode--${status}${end}`} aria-current={isActive ? "step" : undefined}>
      <div className="tnode__card" data-nid={node.id} data-parent={sibs?.parent} data-state={status}>
        <span className="tnode__marker" aria-hidden="true" />
        <div className="tnode__body">
          <span className="tnode__title">{node.label}</span>
          <span className="sr-only"> ({STATUS_WORD[status]})</span>
          <span className="tnode__meta">
            {node.actor && <span className={`tnode__actor tnode__actor--${node.actor}`}>{ACTOR_LABEL[node.actor]}</span>}
            {status === "taken" && ms !== undefined && ms > 0 && <span className="mono">{formatDuration(ms)}</span>}
            {isActive && elapsed !== null && (
              <span className="mono tnode__timer">{formatDuration(elapsed)} so far</span>
            )}
          </span>
          {detail ? <small className="tnode__detail">{detail}</small> : null}
          {node.loopTo && <small className="tnode__detail muted">Loops back to: {node.loopTo}</small>}
          <Extras id={node.id} model={model} view={view} />
          {status !== "excluded" && status !== "pending" && artifacts?.[node.id] && <ArtifactsDrawer items={artifacts[node.id]!} />}
        </div>
      </div>
      {sibs && sibs.above.length > 0 && (
        <>
          <ol className="tchips tchips--above" aria-label="Branches not taken">{sibs.above.map(chipFor(sibs.parent))}</ol>
        </>
      )}
      {sibs && sibs.below.length > 0 && (
        <>
          <ol className="tchips tchips--below" aria-label="Branches not taken">{sibs.below.map(chipFor(sibs.parent))}</ol>
        </>
      )}
      {(fork.main || rest.length > 0) && (
        <ol className={`tree tree--nested ${fork.main ? "tree--line" : "tree--stack"}`}>
          {fork.main && (
            <Node
              key={fork.main.id}
              node={fork.main}
              sibs={{ parent: node.id, above: fork.above, below: fork.below }}
              {...shared}
            />
          )}
          {fork.main
            ? null
            : rest.map(chipFor(node.id))}
        </ol>
      )}
    </li>
  );
}

function Extras({ id, model, view }: { id: NodeId; model: TreeModel; view: ClaimView }): ReactNode {
  const body = extrasBody({ id, model, view });
  if (!body) return null;
  return (
    <details
      className="tdetails"
      onToggle={(e) => {
        const d = e.currentTarget;
        d.closest(".tnode__card")?.classList.toggle("tnode__card--open", d.open);
        if (d.open) requestAnimationFrame(() => fitPopover(d.querySelector<HTMLElement>(".tdetails__pop")));
      }}
    >
      <summary>Details</summary>
      <div className="tdetails__pop">{body}</div>
    </details>
  );
}

function extrasBody({ id, model, view }: { id: NodeId; model: TreeModel; view: ClaimView }): ReactNode {
  const part = splitRid(id);
  const base = part?.base ?? id;
  if (base === "denied" && part) {
    return (
      <ol className="plain tnode__rounds" aria-label={`Round ${part.n} denial`}>
        {model.rounds.filter((r) => r.n === part.n).map((r) => (
          <li key={r.n}>
            <strong>Round {r.n}: denied</strong>
            {r.decision.reason ? `, ${plainReason(r.decision.reason)}` : ""}
            {r.decision.field ? ` (${plainField(r.decision.field)})` : ""}
            {r.decision.raw ? <q className="tnode__quote">{shorten(r.decision.raw)}</q> : null}
            {r.action && <span className="muted"> Then: {plainAction(r.action.kind)}{r.action.reason ? `, ${r.action.reason}` : ""}.</span>}
          </li>
        ))}
      </ol>
    );
  }
  if (base === "missing_field" && model.wholesaler.length > 0) return <Thread label="Wholesaler messages" msgs={model.wholesaler} />;
  if (base === "phone" && model.phone.length > 0) return <Thread label="Phone call transcript" msgs={model.phone} />;
  if (id === "settled" && view.settlement) {
    return (
      <ul className="plain tnode__rounds" aria-label="Ledger transfers">
        {view.settlement.transfers.map((t, i) => (
          <li key={i}>
            <span className="mono">{t.from}</span> to <span className="mono">{t.to}</span>{" "}
            <span className="money">{usd(t.amount)}</span> <span className="muted">{t.kind.replaceAll("_", " ")}</span>
          </li>
        ))}
      </ul>
    );
  }
  return null;
}

function Thread({ label, msgs }: { label: string; msgs: TreeModel["phone"] }) {
  return (
    <ul className="plain tnode__rounds" aria-label={label}>
      {groupExchange(msgs).map((st, i) => {
        const m = st.type === "fallback" ? st.second : st.msg;
        return (
          <li key={i}>
            <span className="muted">{m.direction === "out" ? "We said" : "They said"} ({st.type === "fallback" ? "WhatsApp, then SMS" : m.channel}):</span>{" "}
            <q className="tnode__quote">{shorten(m.text)}</q>
            {st.type === "fallback" && <small className="tnode__detail muted">{st.label}</small>}
            <DeliveryChip chip={st.chip} />
          </li>
        );
      })}
    </ul>
  );
}
