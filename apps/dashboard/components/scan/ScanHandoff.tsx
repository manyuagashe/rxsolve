"use client";

import Link from "next/link";
import { useState } from "react";
import { handoffBlocker, handoffPolicyNote, previewMismatchNote, type HandoffResult, type SavedPolicy } from "@/lib/opportunityScan";

const usd = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD" });
const claimCount = (count: number) => `${count} ${count === 1 ? "claim" : "claims"}`;

type ScanHandoffProps = {
  /** The scanned file. The API scans it again itself instead of trusting this page's results. */
  csv: string;
  selectedIds: string[];
  /** The policy the pipeline will apply; null until it loads. */
  savedPolicy: SavedPolicy | null;
  /** The what-if limit typed in the review queue. */
  previewLimit: number | null;
};

/** Sends the selected claims into the real claim pipeline, after an explicit confirmation. */
export function ScanHandoff({ csv, selectedIds, savedPolicy, previewLimit }: ScanHandoffProps) {
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<HandoffResult | null>(null);

  const blocker = handoffBlocker({ selectedCount: selectedIds.length, confirmed });
  const mismatch = previewMismatchNote(savedPolicy, previewLimit);

  async function send() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/opportunity-scan/handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csv, claim_ids: selectedIds }),
      });
      const body = await response.json().catch(() => null) as HandoffResult | { error?: string } | null;
      if (!response.ok || !body || !("accepted" in body)) {
        throw new Error(body && "error" in body && body.error ? body.error : "The claims could not be sent.");
      }
      setResult(body);
      setConfirmed(false); // a second send needs a fresh confirmation
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The claims could not be sent.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="scan-handoff">
      <label className="scan-handoff__confirm">
        <input type="checkbox" checked={confirmed} disabled={pending} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>{handoffPolicyNote(savedPolicy)}</span>
      </label>
      {mismatch && <small className="tone-warn">{mismatch}</small>}
      <div className="scan-handoff__action">
        <button className="btn" type="button" disabled={blocker !== null || pending} onClick={() => void send()}>
          {pending ? "Sending..." : `Send ${claimCount(selectedIds.length)} to RxSolve`}
        </button>
        {blocker && <small>{blocker}</small>}
      </div>
      {error && <p className="scan-error" role="alert">Not sent: {error}</p>}

      {result && (
        <div className="scan-handoff__result" role="status" aria-live="polite">
          <strong>
            {claimCount(result.accepted.length)} sent to RxSolve, {result.rejected.length} not sent
          </strong>
          {result.accepted.length > 0 && (
            <ul>
              {result.accepted.map((claim) => (
                <li key={claim.claim_id}>
                  <Link className="mono" href={`/claims/${encodeURIComponent(claim.claim_id)}`}>{claim.claim_id}</Link>
                  <span>
                    RxSolve shortfall {usd(claim.rxsolve_shortfall)}
                    {claim.rxsolve_shortfall !== claim.scan_shortfall && ` (your file said ${usd(claim.scan_shortfall)})`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {result.rejected.length > 0 && (
            <ul>
              {result.rejected.map((claim) => (
                <li key={claim.claim_id}>
                  <span className="mono">{claim.claim_id}</span>
                  <span className="tone-warn">{claim.reason}</span>
                </li>
              ))}
            </ul>
          )}
          {result.accepted.length > 0 && <Link className="btn btn--ghost btn--sm" href="/">Watch them on the dashboard</Link>}
        </div>
      )}
    </div>
  );
}
