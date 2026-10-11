/** Maps a claim's channel messages and evidence onto the tree nodes that produced them. Owner: P3. Pure. */
import type { ChannelMessage, Evidence } from "@rxsolve/contracts";
import type { ClaimView } from "./state";
import type { TreeModel } from "./tree";
import { NODE_BY_ID, type NodeId, rid } from "./treeShape";

export type ArtifactKind = "html" | "png" | "pdf" | "txt" | "other";
export type ArtifactRole =
  | "evidence_pdf" | "portal_form" | "portal_status" | "email_sent" | "email_reply"
  | "fax_out" | "fax_reply" | "wholesaler_doc" | "other";

export type ArtifactItem =
  | { type: "file"; name: string; kind: ArtifactKind; role: ArtifactRole; label: string; caption?: string }
  | { type: "text"; label: string; text: string }
  | { type: "fields"; label: string; fields: Record<string, string> };

export const PBM_CHANNELS = new Set(["portal", "email", "fax"]);
const WHOLESALER_FIELDS = /^[a-z_]+_RXS-/;

export const artifactUrl = (name: string) => `/api/artifacts/${encodeURIComponent(name)}`;

export function artifactKind(name: string): ArtifactKind {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "png") return "png";
  if (ext === "pdf") return "pdf";
  if (ext === "txt") return "txt";
  return "other";
}

/** Role and label from the filename prefix the adapters and evidence builder use. */
export function classifyArtifact(name: string): { kind: ArtifactKind; role: ArtifactRole; label: string } {
  const kind = artifactKind(name);
  const shot = kind === "png" ? " screenshot" : "";
  if (name.startsWith("portal_form_")) return { kind, role: "portal_form", label: `Portal form as filed${shot}` };
  if (name.startsWith("portal_status_")) return { kind, role: "portal_status", label: `Portal decision page${shot}` };
  if (name.startsWith("email_sent_")) return { kind, role: "email_sent", label: "Email we sent" };
  if (name.startsWith("email_reply_")) return { kind, role: "email_reply", label: "Email reply from the PBM" };
  if (name.startsWith("fax_reply_")) return { kind, role: "fax_reply", label: "Scanned fax reply from the PBM" };
  if (name.startsWith("fax_")) return { kind, role: "fax_out", label: "Fax cover sheet and evidence" };
  if (name.startsWith("appeal_")) return { kind, role: "evidence_pdf", label: "Appeal packet" };
  if (name.startsWith("wholesaler_invoice_")) return { kind, role: "evidence_pdf", label: "Wholesaler invoice" };
  if (kind === "pdf" && WHOLESALER_FIELDS.test(name)) return { kind, role: "wholesaler_doc", label: "Wholesaler document" };
  return { kind, role: "other", label: name };
}

const field = (k: string) => k.replaceAll("_", " ");

/** The "evidence.txt" view: the evidence.built payload as readable text. */
export function evidenceText(ev: Evidence): string {
  const lines = [
    `Statute: ${ev.statute}`,
    `Entitlement: ${ev.entitlement}`,
    `Amount appealed: $${ev.delta.toFixed(2)}`,
    `Appeal deadline: ${ev.appeal_deadline ?? "none"}`,
    `Completeness: ${Math.round(ev.completeness * 100)}%`,
    `Spec version: ${ev.spec_version}`,
    `Required fields present: ${ev.required_fields_present.map(field).join(", ") || "none"}`,
    "Attachments:",
    ...(ev.attachments.length ? ev.attachments.map((a) => `  - ${a}`) : ["  none"]),
  ];
  return lines.join("\n");
}

/** Keeps a fetched text artifact to a size the page can show. */
export function limitText(text: string, max = 20_000): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

const str = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v) ?? "");

function formFields(m: ChannelMessage): Record<string, string> | null {
  const raw = (m.meta.form ?? m.meta.fields) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  return entries.length ? Object.fromEntries(entries.map(([k, v]) => [k, str(v)])) : null;
}

function files(m: ChannelMessage, skip: Set<string>, caption?: string): ArtifactItem[] {
  return m.attachments
    .filter((n) => !skip.has(n))
    .map((name) => ({ type: "file" as const, name, ...classifyArtifact(name), caption }));
}

/**
 * Artifacts per node. Evidence lists its text view and attachments; the first outbound PBM message
 * belongs to the door branch it used, later ones to the round's refile node; inbound ones to that round's decision node.
 */
export function nodeArtifacts(
  model: Pick<TreeModel, "rounds" | "taken">, view: ClaimView, messages: readonly ChannelMessage[],
): Partial<Record<NodeId, ArtifactItem[]>> {
  const out: Partial<Record<NodeId, ArtifactItem[]>> = {};
  const put = (node: NodeId, ...items: ArtifactItem[]) => {
    if (items.length) out[node] = [...(out[node] ?? []), ...items];
  };
  const claimId = view.claim.claim_id;
  const ev = view.evidence;
  const evNames = new Set(ev?.attachments ?? []);
  if (ev) {
    put("evidence", { type: "text", label: "evidence.txt", text: evidenceText(ev) });
    put("evidence", ...ev.attachments.map((name) => ({ type: "file" as const, name, ...classifyArtifact(name) })));
  }

  const mine = messages.filter((m) => m.claim_id === claimId);
  const pbm = mine.filter((m) => PBM_CHANNELS.has(m.channel) && m.counterparty !== "wholesaler");
  let outIdx = 0;
  for (const m of pbm.filter((x) => x.direction === "out")) {
    const round = model.rounds[outIdx - 1];
    const node: NodeId = outIdx === 0 ? (`door_${m.channel}` in NODE_BY_ID ? (`door_${m.channel}` as NodeId) : "door")
      : round?.nodes.find((n) => n.startsWith("refile")) ?? round?.nodes.at(-1) ?? rid("decision", outIdx + 1);
    outIdx++;
    const f = formFields(m);
    put(node, ...files(m, evNames));
    // An emailed appeal carries its fields inside the letter snapshot, so a separate table would only repeat them.
    const letter = m.attachments.some((n) => n.startsWith("email_sent_"));
    if (f && !letter) put(node, { type: "fields", label: "Fields filed", fields: f });
  }

  // Inbound messages pair with decisions by order: a refile can keep the same ticket id across rounds.
  const inbound = pbm.filter((x) => x.direction === "in");
  inbound.forEach((m, k) => {
    const d = view.decisions[k];
    const node: NodeId = !d ? rid("decision", Math.min(view.decisions.length + 1, 3))
      : rid(d.status === "APPROVED" ? "approved" : "denied", k + 1);
    put(node, ...files(m, evNames));
    const hasText = m.attachments.some((n) => artifactKind(n) === "txt");
    const raw = d?.raw ?? m.text;
    const seen = (out[node] ?? []).some((i) => i.type === "text" && i.text === raw);
    if (m.channel === "portal" && raw && !hasText && !seen) put(node, { type: "text", label: "PBM message (raw)", text: raw });
  });

  const mfRound = model.rounds.find((r) => r.nodes.some((n) => n.startsWith("missing_field")));
  const mfNode = mfRound?.nodes.find((n) => n.startsWith("missing_field")) ?? rid("missing_field", 1);
  for (const m of mine.filter((x) => x.counterparty === "wholesaler" && x.attachments.length > 0)) {
    put(mfNode, ...files(m, evNames, `${m.direction === "in" ? "Wholesaler replied" : "We asked"}: ${m.text}`));
  }
  return out;
}
