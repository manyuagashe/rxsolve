/**
 * Historical-claim opportunity scan.
 *
 * The model may translate unfamiliar column names into this fixed vocabulary. It never reads
 * amounts into invented fields and never decides whether a claim is recoverable. Every value is
 * parsed from the CSV and every status and total below is calculated by deterministic rules.
 */
import { z } from "zod";
import { extract } from "./agents/llm";

export const CANONICAL_HEADERS = [
  "claim_id",
  "fill_date",
  "ndc",
  "drug",
  "pbm",
  "state",
  "total_paid",
  "acquisition_cost",
  "invoice_number",
  "invoice_date",
  "appeal_deadline",
] as const;

/**
 * Columns a file may leave out. The scan does not need them, but the handoff into the claim
 * pipeline does (scan-handoff.ts). They are matched by name only and never sent to the model.
 */
export const OPTIONAL_HEADERS = ["quantity", "rx_number", "plan"] as const;

export type CanonicalHeader = (typeof CANONICAL_HEADERS)[number];
export type OptionalHeader = (typeof OPTIONAL_HEADERS)[number];
export type HeaderMap = Partial<Record<CanonicalHeader, string>>;
type OptionalHeaderMap = Partial<Record<OptionalHeader, string>>;
export type SuggestedHeaderMapping = { source: string; target: CanonicalHeader };
export type ScanStatus = "READY" | "PAID_FAIRLY" | "NEEDS_REVIEW" | "MISSING_DATA" | "EXPIRED";

export type OpportunityClaim = {
  claim_id: string;
  fill_date: string;
  ndc: string;
  drug: string;
  pbm: string;
  state: string;
  total_paid: number;
  acquisition_cost: number;
  invoice_number: string | null;
  invoice_date: string | null;
  appeal_deadline: string;
  quantity: number | null;
  rx_number: string | null;
  plan: string | null;
  shortfall: number;
  status: ScanStatus;
  reason: string;
};

export type OpportunityScanResult = {
  parser: {
    mode: "deterministic" | "llm_assisted";
    mapped_headers: HeaderMap;
  };
  summary: {
    claims_scanned: number;
    underpaid_claims: number;
    ready_claims: number;
    needs_review_claims: number;
    missing_data_claims: number;
    expired_claims: number;
    paid_fairly_claims: number;
    total_shortfall: number;
    ready_to_recover: number;
    estimated_fee: number;
    estimated_pharmacy_net: number;
  };
  claims: OpportunityClaim[];
};

type ScanOptions = {
  now?: Date;
  feePct?: number;
  suggestHeaders?: (unknownHeaders: string[]) => Promise<SuggestedHeaderMapping[]>;
};

const HEADER_ALIASES: Record<CanonicalHeader, string[]> = {
  // No "rxnumber": an Rx Number column is the optional rx_number field, not the claim ID.
  claim_id: ["claimid", "claimnumber", "rxreference"],
  fill_date: ["filldate", "dateofservice", "servicedate"],
  ndc: ["ndc", "productid", "nationaldrugcode"],
  drug: ["drug", "drugname", "medication"],
  pbm: ["pbm", "payer", "payername"],
  state: ["state", "pharmacystate", "jurisdiction"],
  total_paid: ["totalpaid", "amountreceived", "totalreimbursement", "pharmacyrevenue"],
  acquisition_cost: ["acquisitioncost", "drugcost", "wholesalecost", "invoicecost"],
  invoice_number: ["invoicenumber", "invoice", "invoiceref"],
  invoice_date: ["invoicedate", "invoiceissued"],
  appeal_deadline: ["appealdeadline", "appealby", "filebefore"],
};

const OPTIONAL_HEADER_ALIASES: Record<OptionalHeader, string[]> = {
  quantity: ["quantity", "qty", "quantitydispensed"],
  rx_number: ["rxnumber", "rxno", "prescriptionnumber"],
  plan: ["plan", "planname"],
};

const normalized = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
const money = (value: number) => Math.round(value * 100) / 100;

const HeaderSuggestions = z.object({
  mappings: z.array(z.object({
    source: z.string(),
    target: z.enum(CANONICAL_HEADERS),
  })).max(CANONICAL_HEADERS.length),
});

/**
 * Sends column names only—not claim rows, financial values, or patient references—to the model.
 * The returned strings still pass through applySuggestedHeaderMappings before any row is read.
 */
export async function suggestOpportunityHeaders(headers: string[]): Promise<SuggestedHeaderMapping[]> {
  const result = await extract(
    HeaderSuggestions,
    `Map these CSV headers to the allowed RxSolve fields. Omit any header you cannot map with confidence.\n\nCSV headers:\n${headers.map((header) => `- ${header}`).join("\n")}\n\nAllowed targets:\n${CANONICAL_HEADERS.join(", ")}`,
    {
      effort: "low",
      system: "You translate CSV column names into a fixed schema. Return only mappings grounded in the supplied header names. Never invent a source header or a target.",
    },
  );
  return result.mappings;
}

function parseCsvRows(csv: string): string[][] {
  if (new TextEncoder().encode(csv).byteLength > 1_000_000) throw new Error("CSV must be 1 MB or smaller");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < csv.length; i++) {
    const char = csv[i]!;
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && csv[i + 1] === "\n") i++;
      row.push(field.trim());
      field = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("CSV contains an unclosed quoted field");
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows.length > 5_001) throw new Error("CSV may contain at most 5,000 claims");
  return rows;
}

function deterministicHeaderMap(headers: string[]): HeaderMap {
  const result: HeaderMap = {};
  for (const header of headers) {
    const key = normalized(header);
    const target = CANONICAL_HEADERS.find((candidate) => HEADER_ALIASES[candidate].includes(key));
    if (target && result[target] === undefined) result[target] = header;
  }
  return result;
}

/** Matches optional columns among the headers the required columns did not already claim. */
function optionalHeaderMap(headers: string[], required: HeaderMap): OptionalHeaderMap {
  const taken = new Set(Object.values(required));
  const result: OptionalHeaderMap = {};
  for (const header of headers) {
    if (taken.has(header)) continue;
    const key = normalized(header);
    const target = OPTIONAL_HEADERS.find((candidate) => OPTIONAL_HEADER_ALIASES[candidate].includes(key));
    if (target && result[target] === undefined) result[target] = header;
  }
  return result;
}

export function applySuggestedHeaderMappings(
  headers: string[],
  current: HeaderMap,
  suggestions: SuggestedHeaderMapping[],
): HeaderMap {
  const allowedSources = new Set(headers);
  const mappedSources = new Set(Object.values(current));
  const suggestedSources = new Set<string>();
  const result = { ...current };

  for (const suggestion of suggestions) {
    if (!allowedSources.has(suggestion.source)) {
      throw new Error(`header suggestion used unknown source header: ${suggestion.source}`);
    }
    if (!CANONICAL_HEADERS.includes(suggestion.target)) {
      throw new Error(`header suggestion used unsupported target: ${suggestion.target}`);
    }
    if (suggestedSources.has(suggestion.source)) {
      throw new Error(`header suggestion maps one source to more than one target: ${suggestion.source}`);
    }
    suggestedSources.add(suggestion.source);
    if (mappedSources.has(suggestion.source)) continue;
    if (result[suggestion.target] !== undefined) {
      throw new Error(`header suggestion maps more than one source to ${suggestion.target}`);
    }
    result[suggestion.target] = suggestion.source;
    mappedSources.add(suggestion.source);
  }
  return result;
}

function requiredMissing(map: HeaderMap): CanonicalHeader[] {
  return CANONICAL_HEADERS.filter((header) => map[header] === undefined);
}

function requiredText(record: Record<string, string>, source: string, label: string): string {
  const value = record[source]?.trim();
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function optionalText(record: Record<string, string>, source: string): string | null {
  return record[source]?.trim() || null;
}

function nonNegativeAmount(record: Record<string, string>, source: string, label: string): number {
  const raw = record[source]?.trim();
  const value = raw === "" || raw === undefined ? Number.NaN : Number(raw.replace(/^\$/, ""));
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative amount`);
  return money(value);
}

function optionalQuantity(record: Record<string, string>, source: string | undefined): number | null {
  if (source === undefined) return null;
  const raw = optionalText(record, source);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error("Quantity must be a positive number");
  return value;
}

function isoDate(record: Record<string, string>, source: string, label: string): string {
  const value = requiredText(record, source, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!match || !date
    || date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() !== Number(match[2]) - 1
    || date.getUTCDate() !== Number(match[3])) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }
  return value;
}

function optionalIsoDate(record: Record<string, string>, source: string, label: string): string | null {
  const value = optionalText(record, source);
  if (value === null) return null;
  return isoDate({ [source]: value }, source, label);
}

function classify(shortfall: number, deadline: string, invoiceNumber: string | null, invoiceDate: string | null, now: Date) {
  if (shortfall <= 0) return { status: "PAID_FAIRLY" as const, reason: "Reimbursement met or exceeded acquisition cost." };
  if (new Date(`${deadline}T23:59:59Z`).getTime() < now.getTime()) {
    return { status: "EXPIRED" as const, reason: "The appeal deadline has passed." };
  }
  if (!invoiceNumber || !invoiceDate) {
    return { status: "MISSING_DATA" as const, reason: "Invoice number and date are required before filing." };
  }
  if (shortfall <= 0.5) {
    return { status: "NEEDS_REVIEW" as const, reason: "The shortfall is $0.50 or less and needs pharmacist review." };
  }
  return { status: "READY" as const, reason: "Underpaid, in-window, and supported by invoice evidence." };
}

export async function scanOpportunityCsv(csv: string, options: ScanOptions = {}): Promise<OpportunityScanResult> {
  const rows = parseCsvRows(csv.replace(/^\uFEFF/, ""));
  if (rows.length < 2) throw new Error("CSV must contain a header and at least one claim");
  const headers = rows[0]!;
  if (new Set(headers).size !== headers.length) throw new Error("CSV headers must be unique");

  let mappedHeaders = deterministicHeaderMap(headers);
  const optionalHeaders = optionalHeaderMap(headers, mappedHeaders);
  let mode: OpportunityScanResult["parser"]["mode"] = "deterministic";
  let missing = requiredMissing(mappedHeaders);
  if (missing.length && options.suggestHeaders) {
    const knownSources = new Set([...Object.values(mappedHeaders), ...Object.values(optionalHeaders)]);
    const unknownHeaders = headers.filter((header) => !knownSources.has(header));
    const suggestions = await options.suggestHeaders(unknownHeaders);
    mappedHeaders = applySuggestedHeaderMappings(headers, mappedHeaders, suggestions);
    mode = "llm_assisted";
    missing = requiredMissing(mappedHeaders);
  }
  if (missing.length) throw new Error(`CSV is missing required columns: ${missing.join(", ")}`);

  const now = options.now ?? new Date();
  const claims = rows.slice(1).map((values, index): OpportunityClaim => {
    if (values.length !== headers.length) throw new Error(`Row ${index + 2} has ${values.length} columns; expected ${headers.length}`);
    const record = Object.fromEntries(headers.map((header, i) => [header, values[i] ?? ""]));
    const source = mappedHeaders as Record<CanonicalHeader, string>;
    const totalPaid = nonNegativeAmount(record, source.total_paid, "Total Paid");
    const acquisitionCost = nonNegativeAmount(record, source.acquisition_cost, "Acquisition Cost");
    const invoiceNumber = optionalText(record, source.invoice_number);
    const invoiceDate = optionalIsoDate(record, source.invoice_date, "Invoice Date");
    const appealDeadline = isoDate(record, source.appeal_deadline, "Appeal Deadline");
    const shortfall = money(Math.max(0, acquisitionCost - totalPaid));
    const verdict = classify(shortfall, appealDeadline, invoiceNumber, invoiceDate, now);
    return {
      claim_id: requiredText(record, source.claim_id, "Claim ID"),
      fill_date: isoDate(record, source.fill_date, "Fill Date"),
      ndc: requiredText(record, source.ndc, "NDC"),
      drug: requiredText(record, source.drug, "Drug"),
      pbm: requiredText(record, source.pbm, "PBM"),
      state: requiredText(record, source.state, "State").toUpperCase(),
      total_paid: totalPaid,
      acquisition_cost: acquisitionCost,
      invoice_number: invoiceNumber,
      invoice_date: invoiceDate,
      appeal_deadline: appealDeadline,
      quantity: optionalQuantity(record, optionalHeaders.quantity),
      rx_number: optionalHeaders.rx_number === undefined ? null : optionalText(record, optionalHeaders.rx_number),
      plan: optionalHeaders.plan === undefined ? null : optionalText(record, optionalHeaders.plan),
      shortfall,
      status: verdict.status,
      reason: verdict.reason,
    };
  });

  const underpaid = claims.filter((claim) => claim.shortfall > 0);
  const ready = claims.filter((claim) => claim.status === "READY");
  const totalShortfall = money(underpaid.reduce((sum, claim) => sum + claim.shortfall, 0));
  const readyToRecover = money(ready.reduce((sum, claim) => sum + claim.shortfall, 0));
  const estimatedFee = money(readyToRecover * (options.feePct ?? 0.25));

  return {
    parser: { mode, mapped_headers: mappedHeaders },
    summary: {
      claims_scanned: claims.length,
      underpaid_claims: underpaid.length,
      ready_claims: ready.length,
      needs_review_claims: claims.filter((claim) => claim.status === "NEEDS_REVIEW").length,
      missing_data_claims: claims.filter((claim) => claim.status === "MISSING_DATA").length,
      expired_claims: claims.filter((claim) => claim.status === "EXPIRED").length,
      paid_fairly_claims: claims.filter((claim) => claim.status === "PAID_FAIRLY").length,
      total_shortfall: totalShortfall,
      ready_to_recover: readyToRecover,
      estimated_fee: estimatedFee,
      estimated_pharmacy_net: money(readyToRecover - estimatedFee),
    },
    claims,
  };
}
