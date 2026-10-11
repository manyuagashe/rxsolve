/**
 * EmailAdapter (AGT-04). Owner: P2.
 * Composes the appeal with the evidence PDFs attached, posts it to the PBM Sim inbox door, and parses
 * the templated reply with regexes. Door contract: docs/DECISIONS.md (AGT-04 entries).
 */
import { basename, join } from "node:path";
import type { Claim, Decision, DenialReason, Evidence, Reply, Ticket } from "@rxsolve/contracts";
import { EVIDENCE_DIR } from "../agents/packet";
import { safeId, writeArtifact } from "../artifacts";
import { config } from "../config";
import { drugName } from "../reference";
import { record } from "../transcript";
import type { ChannelAdapter } from "./index";

type Door = { thread_id: string; submitted_at: string; expected_response_by: string };
type Mail = { filename: string; content_type: string; content_base64: string };
type Inbound = { status?: string; subject?: string; body?: string; received_at?: string };

export type EmailOpts = { baseUrl?: string; attachmentDir?: string; from?: string };

const REASONS: DenialReason[] = ["missing_field", "insufficient_evidence", "disputed", "window_expired", "not_eligible"];
const slug = (s: string) => s.toLowerCase().replace(/[\s-]+/g, "_");

/** Reads the templated reply body: `Status:`, `Reason:`, `Missing field:`, `Approved amount:` lines. */
export function parseReply(claim_id: string, ticket_id: string, body: string): Decision {
  const line = (label: string) => body.match(new RegExp(`^\\s*(?:${label})\\s*:\\s*(.+?)\\s*$`, "im"))?.[1] ?? null;
  const status = line("status|decision")?.toUpperCase();
  const raw = body.trim();
  if (status?.startsWith("APPROVED")) {
    const amt = line("approved amount|amount approved|amount")?.replace(/[$,\s]/g, "");
    const delta = amt && Number.isFinite(Number(amt)) ? Number(amt) : null;
    return { claim_id, ticket_id, status: "APPROVED", reason: null, field: null, delta, raw };
  }
  if (status?.startsWith("DENIED")) {
    const f = line("missing field|missing|field");
    const r = line("reason|denial reason");
    const named = r ? slug(r) : null;
    const reason: DenialReason = f ? "missing_field" : REASONS.find((x) => x === named) ?? "insufficient_evidence";
    return { claim_id, ticket_id, status: "DENIED", reason, field: reason === "missing_field" && f ? slug(f) : null, delta: null, raw };
  }
  throw new Error(`Unparseable PBM reply for ${ticket_id}`);
}

export class EmailAdapter implements ChannelAdapter {
  channel = "email" as const;
  constructor(private opts: EmailOpts = {}) {}

  private get base() { return this.opts.baseUrl ?? config.pbmSimUrl; }
  private get dir() { return this.opts.attachmentDir ?? EVIDENCE_DIR; }

  private async files(names: string[]): Promise<{ mail: Mail[]; missing: string[] }> {
    const mail: Mail[] = [], missing: string[] = [];
    for (const n of names) {
      const f = Bun.file(join(this.dir, basename(n)));
      if (!(await f.exists())) { missing.push(n); continue; }
      mail.push({ filename: basename(n), content_type: "application/pdf", content_base64: Buffer.from(await f.arrayBuffer()).toString("base64") });
    }
    return { mail, missing };
  }

  /** One prose paragraph built only from evidence values; no colons, so the inbox door never reads it as a field. */
  private summary(claim_id: string, ev: Evidence): string {
    const f = ev.fields;
    const money = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? `$${v.toFixed(2)}` : null);
    const drug = f.ndc ? drugName(String(f.ndc)) : null;
    const what = [`claim ${claim_id}`, drug && `for ${drug}`, f.fill_date && `filled ${f.fill_date}`].filter(Boolean).join(" ");
    const paid = money(f.paid_amount), cost = money(f.acquisition_cost);
    const gap = paid && cost ? `The claim paid ${paid} against an acquisition cost of ${cost}. ` : "";
    return `We are appealing the reimbursement on ${what}. ${gap}The shortfall is $${ev.delta.toFixed(2)}, and we are relying on ${ev.statute}.`;
  }

  private async send(claim_id: string, pbm: string, ev: Evidence, intro: string, thread?: string) {
    const { mail, missing } = await this.files(ev.attachments);
    const lines = [
      `Hello ${pbm} appeals team,`, "", intro, "", this.summary(claim_id, ev), "",
      ev.attachments.length ? `The supporting documents are attached (${ev.attachments.join(", ")}).` : "No documents are attached.",
      "", "Appeal details",
      `Claim: ${claim_id}`, `Statute: ${ev.statute}`, `Amount appealed: ${ev.delta.toFixed(2)}`,
      ...Object.entries(ev.fields).map(([k, v]) => `${k}: ${v === null || v === undefined ? "" : String(v)}`),
      "", `Attachments: ${ev.attachments.join(", ") || "none"}`, "", "Regards,", `${config.pharmacyId} pharmacy`,
    ];
    const msg = {
      from: this.opts.from ?? `appeals@${config.pharmacyId.toLowerCase()}.example`, to: `appeals@${pbm.toLowerCase()}.example`,
      subject: `${thread ? "Re: " : ""}MAC appeal ${claim_id}`, body: lines.join("\n"), claim_id, in_reply_to: thread ?? null, attachments: mail,
    };
    const r = await fetch(`${this.base}/inbox/${pbm}/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg),
    });
    if (!r.ok) throw new Error(`PBM Sim inbox ${pbm}: ${r.status}`);
    return { door: (await r.json()) as Door, msg, missing };
  }

  private async out(t: Pick<Ticket, "claim_id" | "pbm">, ev: Evidence, intro: string, thread?: string): Promise<Ticket> {
    const { door, msg, missing } = await this.send(t.claim_id, t.pbm, ev, intro, thread);
    const sent = `Subject: ${msg.subject}\nTo: ${msg.to}\nIn-Reply-To: ${msg.in_reply_to ?? ""}\n\n${msg.body}\nAttachments: ${ev.attachments.join(", ") || "none"}\n`;
    const snap = await writeArtifact(this.dir, `email_sent_${safeId(t.claim_id)}_${safeId(door.thread_id)}.txt`, sent);
    await record({
      claim_id: t.claim_id, channel: "email", direction: "out", counterparty: t.pbm,
      text: `${msg.subject}\n\n${msg.body}`, attachments: snap ? [...ev.attachments, snap] : ev.attachments,
      meta: { ticket_id: door.thread_id, subject: msg.subject, fields: ev.fields, missing_attachments: missing },
    });
    return { claim_id: t.claim_id, pbm: t.pbm, channel: "email", ticket_id: door.thread_id, submitted_at: door.submitted_at, expected_response_by: door.expected_response_by };
  }

  submit(claim: Claim, ev: Evidence): Promise<Ticket> {
    return this.out(claim, ev, "Please review the attached MAC appeal for underpayment below acquisition cost.");
  }

  async poll(ticket: Ticket): Promise<Decision | null> {
    const r = await fetch(`${this.base}/inbox/${ticket.pbm}/replies/${ticket.ticket_id}`);
    if (r.status === 404 || r.status === 204) return null;
    if (!r.ok) throw new Error(`PBM Sim inbox ${ticket.pbm}: ${r.status}`);
    const m = (await r.json()) as Inbound;
    if (!m.body || m.status === "PENDING") return null;
    const d = parseReply(ticket.claim_id, ticket.ticket_id, m.body);
    const snap = await writeArtifact(
      this.dir, `email_reply_${safeId(ticket.claim_id)}_${safeId(ticket.ticket_id)}.txt`,
      `Subject: ${m.subject ?? "Re: MAC appeal"}\nFrom: ${ticket.pbm}\nIn-Reply-To: ${ticket.ticket_id}\n\n${m.body}\n`,
    );
    await record({
      claim_id: ticket.claim_id, channel: "email", direction: "in", counterparty: ticket.pbm,
      attachments: snap ? [snap] : [],
      text: `${m.subject ?? "Re: MAC appeal"}\n\n${m.body}`, meta: { ticket_id: ticket.ticket_id, subject: m.subject ?? null },
    });
    return d;
  }

  reply(ticket: Ticket, msg: Reply): Promise<Ticket> {
    return this.out(ticket, msg.evidence, msg.note ?? "Refiling with the requested document attached.", ticket.ticket_id);
  }
}
