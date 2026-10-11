/**
 * Scan handoff: turns selected opportunity-scan rows into real claims and starts the existing
 * orchestrator on them. Nothing here decides whether a claim is recoverable. The Watcher, the
 * Evidence Builder and the standing-authorization gate judge each claim exactly as they judge a
 * claim from the live feed.
 *
 * Two rules protect the pipeline:
 * - Acquisition cost comes from RxSolve's invoice data, never from the uploaded file.
 * - The server re-runs the scan itself, so a request cannot claim a row is ready when it is not.
 */
import { Claim, PBM } from "@rxsolve/contracts";
import { config } from "./config";
import { getDb } from "./db";
import { deadlineFor } from "./deadlines";
import { bus } from "./events";
import { scanOpportunityCsv, suggestOpportunityHeaders, type OpportunityClaim } from "./opportunity-scan";
import { processClaimSafe } from "./orchestrator";
import { getPolicy } from "./policy";
import { contractUnit, drugName, invoice, nadacUnit } from "./reference";

export const MAX_HANDOFF_CLAIMS = 25;
const DEFAULT_PLAN = "Historical upload";

export type HandoffConversion = { ok: true; claim: Claim } | { ok: false; reason: string };
export type HandoffAccepted = { claim_id: string; scan_shortfall: number; rxsolve_shortfall: number };
export type HandoffRejected = { claim_id: string; reason: string };
export type HandoffResult = {
  /** The pharmacy's saved standing authorization the pipeline applies. The handoff never changes it. */
  policy: { auto_file_max: number; paused: boolean };
  accepted: HandoffAccepted[];
  rejected: HandoffRejected[];
};
export type HandoffRequest = { csv: string; claimIds: string[] };

const money = (value: number) => Math.round(value * 100) / 100;
const reject = (reason: string): HandoffConversion => ({ ok: false, reason });

/** Converts one scan row into a pipeline Claim, or explains why it cannot be handed over. */
export function toHandoffClaim(row: OpportunityClaim, opts: { now: Date; pharmacyId: string }): HandoffConversion {
  if (row.status !== "READY" && row.status !== "NEEDS_REVIEW") return reject(row.reason);
  if (row.quantity === null) return reject("Quantity is required to price the claim.");
  if (row.rx_number === null) return reject("Rx number is required by every PBM.");

  const pbm = PBM.safeParse(row.pbm);
  if (!pbm.success) return reject(`RxSolve cannot file with ${row.pbm}.`);

  const invoiceLine = invoice(row.ndc);
  if (!invoiceLine) return reject("RxSolve has no invoice on file for this drug.");

  // The pipeline's own clock: business days from the fill date under the state's statute.
  const deadline = deadlineFor(row.state, row.fill_date);
  const today = opts.now.toISOString().slice(0, 10);
  if (deadline < today) return reject(`The appeal window closed on ${deadline}.`);

  const plan = row.plan ?? DEFAULT_PLAN;
  const nadac = nadacUnit(row.ndc);
  const contract = contractUnit(plan, row.ndc);
  const claim = Claim.parse({
    claim_id: row.claim_id,
    pharmacy_id: opts.pharmacyId,
    pbm: pbm.data,
    state: row.state,
    plan,
    patient_ref: `PT-SCAN-${row.claim_id}`, // opaque; the upload never carries patient details
    ndc: row.ndc,
    qty: row.quantity,
    fill_date: row.fill_date,
    paid_amount: row.total_paid,
    acquisition_cost: money(invoiceLine.unit_cost * row.quantity),
    nadac: nadac === undefined ? null : money(nadac * row.quantity),
    contract_rate: contract === undefined ? null : money(contract * row.quantity),
    // The Evidence Builder reads the Rx number from the NCPDP request, so carry a minimal one.
    ncpdp: {
      transaction: "B1",
      request: { "401-D1": row.fill_date.replaceAll("-", ""), "402-D2": row.rx_number, "407-D7": row.ndc, "442-E7": row.quantity },
      response: { "509-F9": row.total_paid },
    },
  });
  return { ok: true, claim };
}

/**
 * Re-scans the file and queues accepted claims under the pharmacy's saved policy. The scan page's
 * limit is a preview only: writing it here would also change how live feed claims are gated.
 */
export async function handoffScanClaims(request: HandoffRequest, now = new Date()): Promise<HandoffResult> {
  const scan = await scanOpportunityCsv(request.csv, {
    now,
    suggestHeaders: config.agentApiKey ? suggestOpportunityHeaders : undefined,
  });
  const db = getDb();
  const accepted: Array<{ claim: Claim; summary: HandoffAccepted }> = [];
  const rejected: HandoffRejected[] = [];

  for (const claimId of new Set(request.claimIds)) {
    const rows = scan.claims.filter((row) => row.claim_id === claimId);
    if (rows.length === 0) {
      rejected.push({ claim_id: claimId, reason: "This claim is not in the uploaded file." });
      continue;
    }
    if (rows.length > 1) {
      rejected.push({ claim_id: claimId, reason: "This claim ID appears more than once in the file." });
      continue;
    }
    const row = rows[0]!;
    const conversion = toHandoffClaim(row, { now, pharmacyId: config.pharmacyId });
    if (!conversion.ok) {
      rejected.push({ claim_id: claimId, reason: conversion.reason });
      continue;
    }
    if (await db.claims.get(claimId)) {
      rejected.push({ claim_id: claimId, reason: "This claim is already in RxSolve." });
      continue;
    }
    const { claim } = conversion;
    const rxsolveShortfall = money(Math.max(0, (claim.acquisition_cost ?? 0) - claim.paid_amount));
    accepted.push({ claim, summary: { claim_id: claimId, scan_shortfall: row.shortfall, rxsolve_shortfall: rxsolveShortfall } });
  }

  const saved = await getPolicy(config.pharmacyId);
  const policy = { auto_file_max: saved.auto_file_max, paused: saved.paused };

  for (const { claim } of accepted) {
    await db.claims.upsert(claim);
    bus.emit("claim.received", claim.claim_id, { ...claim, drug: drugName(claim.ndc) });
    void processClaimSafe(claim.claim_id);
  }

  return {
    policy,
    accepted: accepted.map((entry) => entry.summary),
    rejected,
  };
}
