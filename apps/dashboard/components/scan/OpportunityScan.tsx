"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Columns3, Download, ListChecks, Play, ShieldCheck, Upload } from "lucide-react";
import { PolicySetup } from "@/components/scan/PolicySetup";
import { Panel } from "@/components/ui/Panel";
import { Pill } from "@/components/ui/Pill";
import { prettyPbm } from "@/lib/claimRows";
import {
  remainingScanDelay,
  reviewQueue,
  scanStatusPresentation,
  type OpportunityScanResult,
} from "@/lib/opportunityScan";
import { buildExampleCsv, EXAMPLE_SCANS, exampleFileName, type ExampleScanId } from "@/lib/scanExamples";
import { useCountUp } from "@/lib/useCountUp";

const usd = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD" });
const claimCount = (count: number) => `${count} ${count === 1 ? "claim" : "claims"}`;

const STEPS: Array<{ icon: ReactNode; title: string; body: string }> = [
  { icon: <Columns3 />, title: "Matches columns", body: "Unfamiliar column names can be matched without sharing claim rows or dollar amounts." },
  { icon: <ListChecks />, title: "Applies the same rules", body: "Code checks every amount, deadline and invoice, then adds up the totals." },
  { icon: <ShieldCheck />, title: "Files nothing on its own", body: "Claims move only when you send them, under your saved auto-file limit." },
];

/** A summary figure. The headline one uses the dashboard's hero numerals and counts up. */
function Metric({ label, value, note, hero = false }: { label: string; value: number; note: ReactNode; hero?: boolean }) {
  const shown = useCountUp(value);
  return (
    <div className={`panel scan-metric${hero ? " scan-metric--hero" : ""}`}>
      <div className="label-tracked">{label}</div>
      <div className={hero ? "hero__num money" : "scan-metric__num money"} aria-label={usd(value)}>{usd(shown)}</div>
      <p className="hero__sub">{note}</p>
    </div>
  );
}

export function OpportunityScan() {
  const summaryRef = useRef<HTMLElement>(null);
  const [result, setResult] = useState<OpportunityScanResult | null>(null);
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [scannedCsv, setScannedCsv] = useState(""); // kept so the handoff can send the same file
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staged, setStaged] = useState(false);
  const [selectedExampleId, setSelectedExampleId] = useState<ExampleScanId>(EXAMPLE_SCANS[0]!.id);
  const selectedExample = EXAMPLE_SCANS.find((example) => example.id === selectedExampleId) ?? EXAMPLE_SCANS[0]!;

  useEffect(() => {
    if (result) summaryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [result]);

  async function analyze(csv: string, name: string) {
    const startedAt = Date.now();
    setPending(true);
    setError(null);
    setStaged(false);
    try {
      const response = await fetch("/api/opportunity-scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csv }),
      });
      const body = await response.json().catch(() => null) as OpportunityScanResult | { error?: string } | null;
      if (!response.ok || !body || !("claims" in body)) {
        throw new Error(body && "error" in body && body.error ? body.error : "The scan could not be completed.");
      }
      const waitMs = remainingScanDelay(startedAt);
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      setResult(body);
      setSourceName(name);
      setScannedCsv(csv);
    } catch (cause) {
      setResult(null);
      setSourceName(null);
      setError(cause instanceof Error ? cause.message : "The scan could not be completed.");
    } finally {
      setPending(false);
    }
  }

  function downloadExample() {
    const url = URL.createObjectURL(new Blob([buildExampleCsv(selectedExample.id, new Date())], { type: "text/csv" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: exampleFileName(selectedExample.id) });
    link.click();
    URL.revokeObjectURL(url);
  }

  async function chooseFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 1_000_000) {
      setError("Choose a CSV that is 1 MB or smaller.");
      return;
    }
    await analyze(await file.text(), file.name);
  }

  const queue = result ? reviewQueue(result.claims) : [];

  return (
    <>
      <section className="scan-intro" aria-labelledby="scan-intro-title">
        <div className="scan-intro__copy">
          <div className="label-tracked">Historical recovery scan</div>
          <h1 id="scan-intro-title" className="scan-intro__title">Find the recoverable losses already hiding in your claims.</h1>
          <p className="scan-intro__lede">Run an example or upload a pharmacy claims export. RxSolve checks the shortfall, evidence and filing deadline on every claim before anything is filed.</p>
          <ol className="scan-steps">
            {STEPS.map((step) => (
              <li key={step.title}>
                <span className="hex-orb hex-orb--info scan-steps__orb" aria-hidden="true">{step.icon}</span>
                <span><b>{step.title}</b>{step.body}</span>
              </li>
            ))}
          </ol>
        </div>

        <div className="panel scan-launcher">
          <label className="scan-example-picker">
            <span className="label-tracked">Example scenario</span>
            <select
              value={selectedExampleId}
              disabled={pending}
              onChange={(event) => setSelectedExampleId(event.target.value as ExampleScanId)}
            >
              {EXAMPLE_SCANS.map((example) => (
                <option key={example.id} value={example.id}>{example.name}</option>
              ))}
            </select>
            <small>{selectedExample.description}</small>
          </label>
          <div className="scan-launcher__actions">
            <button
              className="btn btn--ghost"
              type="button"
              aria-controls="scan-summary"
              onClick={() => void analyze(buildExampleCsv(selectedExample.id, new Date()), selectedExample.name)}
              disabled={pending}
            >
              <Play aria-hidden="true" />{pending ? "Checking claims..." : "Run example CSV"}
            </button>
            <label className="btn scan-file"><Upload aria-hidden="true" />Choose a CSV
              <input
                type="file"
                accept=".csv,text/csv"
                disabled={pending}
                onChange={(event) => void chooseFile(event.target.files?.[0])}
              />
            </label>
          </div>
          <button className="scan-launcher__download" type="button" onClick={downloadExample} disabled={pending}>
            <Download aria-hidden="true" />Download this example to try the upload
          </button>
          {pending && (
            <div className="scan-progress" role="status" aria-live="polite">
              <span>Analyzing claim data</span>
              <div className="scan-progress__track" aria-hidden="true"><i /></div>
            </div>
          )}
          {error && <p className="scan-error" role="alert">Scan stopped: {error}</p>}
        </div>
      </section>

      {result && (
        <>
          <section id="scan-summary" ref={summaryRef} className="scan-summary" aria-label="Opportunity summary" aria-live="polite">
            <Metric
              hero
              label="Ready to recover"
              value={result.summary.ready_to_recover}
              note={<><strong>{claimCount(result.summary.ready_claims)}</strong> with complete evidence and an open deadline</>}
            />
            <Metric
              label="Total shortfall found"
              value={result.summary.total_shortfall}
              note={<><strong>{result.summary.underpaid_claims} of {result.summary.claims_scanned}</strong> claims were underpaid</>}
            />
            <Metric
              label="Estimated pharmacy net"
              value={result.summary.estimated_pharmacy_net}
              note={<>after an estimated <span className="money hero__fees">{usd(result.summary.estimated_fee)}</span> RxSolve fee</>}
            />
          </section>

          <Panel
            id="scan-triage"
            title="Triage"
            subtitle={`${sourceName} · ${result.parser.mode === "llm_assisted" ? "columns matched automatically" : "standard column match"}`}
            aside={claimCount(result.summary.claims_scanned)}
          >
            <div className="scan-buckets" aria-label="Claim categories">
              <Pill tone="good">{result.summary.ready_claims} ready</Pill>
              <Pill tone="warn">{result.summary.needs_review_claims} need review</Pill>
              <Pill tone="warn">{result.summary.missing_data_claims} missing evidence</Pill>
              <Pill tone="bad">{result.summary.expired_claims} expired</Pill>
              <Pill tone="muted">{result.summary.paid_fairly_claims} paid fairly</Pill>
            </div>

            <div className="scan-table-wrap">
              <table className="scan-table">
                <thead>
                  <tr><th>Claim</th><th>Drug</th><th>PBM</th><th>Paid</th><th>Cost</th><th>Shortfall</th><th>Decision</th></tr>
                </thead>
                <tbody>
                  {result.claims.map((claim) => {
                    const presentation = scanStatusPresentation(claim.status);
                    return (
                      <tr key={claim.claim_id}>
                        <td className="money">{claim.claim_id}</td>
                        <td><strong>{claim.drug}</strong><small>{claim.state} · deadline {claim.appeal_deadline}</small></td>
                        <td>{prettyPbm(claim.pbm)}</td>
                        <td className="money">{usd(claim.total_paid)}</td>
                        <td className="money">{usd(claim.acquisition_cost)}</td>
                        <td className={`money ${claim.shortfall > 0 ? "tone-bad" : "tone-muted"}`}>{usd(claim.shortfall)}</td>
                        <td><Pill tone={presentation.tone}>{presentation.label}</Pill><small>{claim.reason}</small></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="scan-stage">
              <div>
                <strong>{staged ? `${claimCount(queue.length)} moved to the review queue` : "Nothing will be filed yet"}</strong>
                <p>{staged ? "Choose the claims below, then send them to RxSolve." : "Review ready and needs-review claims together before anything is sent."}</p>
              </div>
              <button className="btn" type="button" disabled={!queue.length || staged} onClick={() => setStaged(true)}>
                {staged ? "Review queue open" : `Review ${claimCount(queue.length)}`}
              </button>
            </div>
          </Panel>

          {staged && <PolicySetup claims={queue} csv={scannedCsv} />}
        </>
      )}
    </>
  );
}
