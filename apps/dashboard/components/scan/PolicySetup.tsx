"use client";

import { useEffect, useState } from "react";
import { ScanHandoff } from "@/components/scan/ScanHandoff";
import { Panel } from "@/components/ui/Panel";
import {
  DEFAULT_AUTO_FILE_MAX,
  parseAutoFileMax,
  previewPolicy,
  readyClaimIds,
  reviewQueue,
  scanStatusPresentation,
  toggleSelected,
  type SavedPolicy,
  type ScanClaim,
} from "@/lib/opportunityScan";

const usd = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD" });
const claimCount = (count: number) => `${count} ${count === 1 ? "claim" : "claims"}`;

type PolicySetupClaim = Pick<ScanClaim, "claim_id" | "drug" | "pbm" | "status" | "shortfall" | "reason">;

/**
 * Review queue and policy preview for a finished scan. The pharmacist picks claims and a dollar
 * limit, sees which claims would file on their own and which would wait for approval, and can
 * then send the selection to the claim pipeline. The limit is a what-if preview that starts at the
 * saved policy; sending never changes the policy. `csv` is the scanned file's text.
 */
export function PolicySetup({ claims, csv }: { claims: PolicySetupClaim[]; csv: string }) {
  const queue = reviewQueue(claims);
  // Ready claims start selected. Needs-review claims are opt-in because a person has to look at them.
  const [selectedIds, setSelectedIds] = useState<string[]>(() => readyClaimIds(queue));
  const [limitText, setLimitText] = useState(String(DEFAULT_AUTO_FILE_MAX));
  const [limitEdited, setLimitEdited] = useState(false);
  const [savedPolicy, setSavedPolicy] = useState<SavedPolicy | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/opportunity-scan/policy")
      .then((response) => (response.ok ? response.json() as Promise<SavedPolicy> : null))
      .then((policy) => { if (!cancelled && policy) setSavedPolicy(policy); })
      .catch(() => {}); // the handoff still runs under the saved policy; the page just cannot name it
    return () => { cancelled = true; };
  }, []);

  // Start the preview at the saved limit unless the pharmacist has already typed one.
  useEffect(() => {
    if (savedPolicy && !limitEdited) setLimitText(String(savedPolicy.auto_file_max));
  }, [savedPolicy, limitEdited]);

  const autoFileMax = parseAutoFileMax(limitText);
  const preview = autoFileMax === null ? null : previewPolicy(queue, selectedIds, autoFileMax);
  const waitingReasons = new Map(preview?.needsApproval.map((entry) => [entry.claim.claim_id, entry.why]));

  function routeLabel(claimId: string): string {
    if (!selectedIds.includes(claimId)) return "Not selected";
    if (!preview) return "Enter a limit";
    return waitingReasons.get(claimId) ?? "Would file automatically";
  }

  return (
    <Panel id="scan-policy" title="Review queue and policy" aside={`${claimCount(selectedIds.length)} selected of ${queue.length}`}>
      <label className="scan-policy-limit">
        <span>Auto-file underpayments up to</span>
        <input
          type="text"
          inputMode="decimal"
          value={limitText}
          aria-invalid={autoFileMax === null}
          aria-describedby="scan-policy-limit-help"
          onChange={(event) => { setLimitEdited(true); setLimitText(event.target.value); }}
        />
        <small id="scan-policy-limit-help" className={autoFileMax === null ? "tone-bad" : undefined}>
          {autoFileMax === null
            ? "Enter a dollar amount such as 100 or 25.50."
            : "Preview: claims over this amount would wait for your approval."}
        </small>
      </label>

      <div className="scan-table-wrap">
        <table className="scan-table scan-table--queue">
          <thead>
            <tr><th>Include</th><th>Claim</th><th>Drug</th><th>Shortfall</th><th>Scan result</th><th>Under this policy</th></tr>
          </thead>
          <tbody>
            {queue.map((claim) => {
              const presentation = scanStatusPresentation(claim.status);
              return (
                <tr key={claim.claim_id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Include ${claim.claim_id}`}
                      checked={selectedIds.includes(claim.claim_id)}
                      onChange={() => setSelectedIds((current) => toggleSelected(current, claim.claim_id))}
                    />
                  </td>
                  <td className="mono">{claim.claim_id}</td>
                  <td><strong>{claim.drug}</strong><small>{claim.pbm.replace("PBM_", "PBM ")}</small></td>
                  <td className="tone-bad">{usd(claim.shortfall)}</td>
                  <td><span className={`scan-status scan-status--${presentation.tone}`}>{presentation.label}</span></td>
                  <td>{routeLabel(claim.claim_id)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {preview && (
        <div className="scan-buckets" role="status" aria-live="polite">
          <span><b>{claimCount(preview.autoFile.length)}</b> would file automatically ({usd(preview.autoFileTotal)})</span>
          <span><b>{claimCount(preview.needsApproval.length)}</b> would wait for your approval ({usd(preview.needsApprovalTotal)})</span>
          <span><b>{usd(preview.selectedTotal)}</b> selected in total</span>
        </div>
      )}
      <p className="scan-policy-note">Nothing is filed until you send claims to RxSolve. RxSolve then prices each claim from its own invoice records.</p>
      <ScanHandoff csv={csv} selectedIds={selectedIds} savedPolicy={savedPolicy} previewLimit={autoFileMax} />
    </Panel>
  );
}
