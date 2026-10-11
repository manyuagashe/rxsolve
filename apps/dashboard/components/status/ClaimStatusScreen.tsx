"use client";
/** Per-claim status screen (UI-03/UI-04): header, path taken, static tree, time split. Owner: P3. */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Maximize2, Minimize2 } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { usd } from "@/components/panels/types";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { nodeArtifacts } from "@/lib/artifacts";
import { doorWord, stageTone, statusSentence } from "@/lib/claims";
import { evidenceChecks, probeNames } from "@/lib/evidenceChecks";
import { useArtifactProbes } from "./useArtifactProbes";
import { stageLabel } from "@/lib/plain";
import { exchangeFor, rawFields } from "@/lib/exchange";
import { prettyPbm } from "@/lib/claimRows";
import { ExchangeList } from "./ExchangePanel";
import { deadlineLabel, deadlineUrgent, useDeadlineClock } from "@/lib/deadline";
import { useLive } from "@/lib/live";
import { deriveTree, formatDuration, nodeStatuses } from "@/lib/tree";
import { StatusTree } from "./StatusTree";

function useSecondClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

export function ClaimStatusScreen({ claimId }: { claimId: string }) {
  const live = useLive();
  const view = live.claims[claimId];
  const minuteNow = useDeadlineClock();
  const [flight, setFlight] = useState(false);
  const now = useSecondClock(flight);

  const model = useMemo(
    () => (view ? deriveTree(view, live.messages, live.log, now) : null),
    [view, live.messages, live.log, now],
  );
  const inFlight = model !== null && model.active !== null;
  useEffect(() => setFlight(inFlight), [inFlight]);
  const statuses = useMemo(() => (model ? nodeStatuses(model) : null), [model]);

  const artifacts = useMemo(() => (model && view ? nodeArtifacts(model, view, live.messages) : undefined), [model, view, live.messages]);
  const exchange = useMemo(() => exchangeFor(claimId, live.messages, live.phone), [claimId, live.messages, live.phone]);
  const probes = useArtifactProbes(view ? probeNames(view) : []);
  const [treeFull, setTreeFull] = useState(false);
  useEffect(() => {
    if (!treeFull) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setTreeFull(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [treeFull]);

  return (
    <div className="dashboard-shell">
      <AppHeader live={live} compact />
      <main className="status-screen" aria-label="Claim status">
        <Link href="/" className="status-back"><ArrowLeft aria-hidden="true" />Back to all claims</Link>
        {!view || !model || !statuses ? (
          <Panel id="status-missing" title="Claim status">
            <p className="empty" role="status">
              {live.connected
                ? "This claim is not in the live feed. The link may be wrong, or the feed is still replaying."
                : "Connecting to the live stream to load this claim."}
            </p>
            <Link href="/" className="btn btn--ghost btn--sm">Go to the claims list</Link>
          </Panel>
        ) : (
          <>
            <header className="status-head panel">
              <div>
                <span className="status-head__id money">{claimId}</span>
                <h2 className="status-head__drug">{view.claim.drug || "Drug unavailable"}</h2>
                <p className="caption">{prettyPbm(view.claim.pbm)} · {view.ticket?.channel ? `${doorWord(view.ticket.channel)}` : "not filed yet"}</p>
              </div>
              <dl className="status-head__facts">
                <div><dt>Underpaid by</dt><dd className="money">{usd(view.verdict?.delta)}</dd><small className="muted">Paid {usd(view.claim.paid_amount)} · drug cost {usd(view.claim.acquisition_cost)}</small></div>
                <div>
                  <dt>Appeal deadline</dt>
                  <dd className={deadlineUrgent(view.verdict?.appeal_deadline, minuteNow) && view.stage !== "SETTLED" ? "tone-bad" : ""}>
                    {view.stage === "SETTLED" ? "Satisfied" : deadlineLabel(view.verdict?.appeal_deadline, minuteNow)}
                  </dd>
                </div>
                <div><dt>Stage</dt><dd><Pill tone={stageTone(view.stage)}>{stageLabel(view.stage)}</Pill></dd></div>
              </dl>
              <div className="status-head__row">
                <p className="status-head__now" role="status" aria-live="polite">{statusSentence(view, usd)}</p>
                <ul className="evidence" aria-label="Evidence checklist">
                  {evidenceChecks(view, exchange, probes).map((e) => <li key={e.state} className={`tone-${e.tone}`}>{e.label}</li>)}
                </ul>
              </div>
              {(view.stage === "FILED" || view.stage === "NEGOTIATING") && (
                <div className="agent-banner">
                  <span className="agent-banner__dot" aria-hidden="true" />
                  Agent is working the {prettyPbm(view.claim.pbm)} {doorWord(view.ticket?.channel)} by itself. No human is touching it.
                </div>
              )}
            </header>

            <div className="status-grid">
              <Panel
                id="status-tree"
                title="Decision tree"
                subtitle="Taken path lit, other branches dimmed"
                className={treeFull ? "tree-panel--full" : ""}
                aside={
                  <button type="button" onClick={() => setTreeFull((v) => !v)} aria-pressed={treeFull} aria-label={treeFull ? "Exit full screen" : "Show the tree full screen"}>
                    {treeFull ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
                  </button>
                }
              >
                <StatusTree model={model} statuses={statuses} view={view} now={now} artifacts={artifacts} />
              </Panel>
              <section className="panel panel--stack" aria-labelledby="status-path-title">
                <details className="path-disclosure">
                  <summary className="path-disclosure__summary">
                    <span className="panel__head">
                      <h2 id="status-path-title">Path taken ({model.path.length} step{model.path.length === 1 ? "" : "s"})</h2>
                      <span className="panel__aside path-disclosure__hint">
                        <span className="path-disclosure__show">Show</span>
                        <span className="path-disclosure__hide">Hide</span>
                        <span className="path-disclosure__chevron" aria-hidden="true" />
                      </span>
                    </span>
                  </summary>
                  <ol className="plain path-list" aria-label="Steps this claim took, in order">
                    {model.path.map((p, i) => (
                      <li key={`${p.node}-${i}`} aria-current={p.inFlight ? "step" : undefined}>
                        {p.text}{p.inFlight ? " (in progress)" : ""}
                      </li>
                    ))}
                  </ol>
                </details>
              </section>
            </div>
            <Panel id="status-exchange" title="Exchange" subtitle="Every channel message for this claim, oldest first">
              <ExchangeList messages={exchange} />
            </Panel>
            <Panel id="status-details" title="Claim as received (NCPDP-shaped)">
              <details className="details">
                <summary>Raw fields and identifiers</summary>
                <dl>
                  {rawFields(view).map(([k, v], i) => (<div key={`${k}-${i}`} style={{ display: "contents" }}><dt>{k}</dt><dd className="mono">{v}</dd></div>))}
                </dl>
              </details>
            </Panel>
            <footer className="status-foot panel" aria-label="Time split">
              <p>
                <strong>Our time</strong> <span className="mono">{formatDuration(model.ourMs) || "0s"}</span>
                {" "}<span className="muted">(rule checks and agent work)</span>
              </p>
              <p>
                <strong>External wait</strong> <span className="mono">{formatDuration(model.outsideMs) || "0s"}</span>
                {" "}<span className="muted">(PBM, wholesaler, pharmacist, ledger)</span>
              </p>
              <TimeSplit ours={model.ourMs} outside={model.outsideMs} />
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

function TimeSplit({ ours, outside }: { ours: number; outside: number }) {
  const total = ours + outside;
  const pct = total > 0 ? Math.round((ours / total) * 100) : 0;
  return (
    <div
      className="timesplit"
      role="img"
      aria-label={total > 0 ? `${pct} percent of elapsed time is ours, ${100 - pct} percent is external wait` : "No time recorded yet"}
    >
      <span className="timesplit__ours" style={{ width: `${pct}%` }} />
    </div>
  );
}
