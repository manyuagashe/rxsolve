"use client";
/** The single list of claims read from the pharmacy's claim feed, newest first, as riveted glass plates. Owner: P3. */
import Link from "next/link";
import { useMemo } from "react";
import { ArrowUpRight, Clock3 } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { buildClaimRows, rowSummary } from "@/lib/claimRows";
import { deadlineShort, deadlineUrgent, useDeadlineClock } from "@/lib/deadline";
import { type PanelProps, usd } from "./types";

const STEPS = ["Detected", "Proof built", "Filed", "PBM decision", "Paid"];

export function ClaimsPanel({ live }: PanelProps) {
  const now = useDeadlineClock();
  const rows = useMemo(() => buildClaimRows(live), [live]);

  return (
    <Panel
      id="claims"
      title="Claims"
      subtitle={`${rows.length} from the pharmacy's claim feed`}
      aside={<span className="hex hex--brand" aria-hidden="true" />}
      bare
      className="panel--fill"
    >
      <div className="claims-wrap">
        <ul className="plain claims" aria-label="Claims">
          {rows.map((r) => {
            const { summary, label } = rowSummary(r, now);
            const urgent = !r.settled && !r.paidAtCost && deadlineUrgent(r.deadline ?? undefined, now);
            const done = r.progress.filter(Boolean).length;
            return (
              <li key={r.claimId} className={`claim-plate bolts${r.quiet ? " claim-plate--quiet" : ""}`}>
                {r.touched !== null && <span key={r.touched} className="scan" aria-hidden="true" />}
                <div className="claim-plate__top">
                  <Pill tone={r.pill.tone}>{r.pill.label}</Pill>
                  <span className="claim-plate__id money">{r.claimId}</span>
                </div>
                <strong className="claim-plate__drug">{r.drug}</strong>
                <small className="muted">{summary}</small>
                <div className="claim-plate__mid">
                  <div>
                    <div className="label-tracked">{r.paidAtCost ? "Paid fairly" : r.settled ? "Recovered" : "Underpaid by"}</div>
                    <div className={`claim-plate__delta money${r.settled ? " tone-good" : ""}`}>
                      {r.paidAtCost ? "No recovery needed" : usd(r.delta)}
                    </div>
                  </div>
                  {!r.paidAtCost && (
                    <span className="hexsteps" role="img" aria-label={`${done} of 5 steps done: ${STEPS.filter((_, i) => r.progress[i]).join(", ") || "none yet"}`}>
                      {r.progress.map((lit, i) => <span key={i} className={`hex hexsteps__dot${lit ? " hexsteps__dot--lit" : ""}`} />)}
                    </span>
                  )}
                </div>
                <div className="claim-plate__foot">
                  <span className={`claim-plate__deadline${urgent ? " tone-bad" : ""}`}>
                    <Clock3 aria-hidden="true" />
                    {r.settled || r.paidAtCost ? "Satisfied" : r.deadline ? `Appeal deadline · ${deadlineShort(r.deadline, now)}` : "Checking the claim"}
                  </span>
                  <Link className="claim-plate__see" href={`/claims/${encodeURIComponent(r.claimId)}`} aria-label={`See status for ${label}`}>
                    See status <ArrowUpRight aria-hidden="true" />
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
        {rows.length === 0 && <p className="empty">Waiting for the pharmacy&apos;s claim feed. Claims appear here as the store&apos;s system bills the PBM.</p>}
      </div>
    </Panel>
  );
}
