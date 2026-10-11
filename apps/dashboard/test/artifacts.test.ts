import { expect, test } from "bun:test";
import type { ChannelMessage } from "@rxsolve/contracts";
import { artifactUrl, classifyArtifact, evidenceText, limitText, nodeArtifacts } from "../lib/artifacts";
import type { ClaimView } from "../lib/state";

const claim = { claim_id: "RXS-1", drug: "Metformin", acquisition_cost: 10, pbm: "PBM_PORTAL" } as ClaimView["claim"];
const ev = {
  claim_id: "RXS-1", statute: "TN 56-7-3105", entitlement: "MAC", attachments: ["appeal_RXS-1.pdf", "wholesaler_invoice_RXS-1.pdf"],
  required_fields_present: ["claim_id", "invoice_number"], spec_version: "1", completeness: 1, fields: {}, delta: 4.5, appeal_deadline: "2026-10-20",
} as NonNullable<ClaimView["evidence"]>;
const msg = (o: Partial<ChannelMessage>): ChannelMessage =>
  ({ claim_id: "RXS-1", channel: "portal", direction: "out", counterparty: "PBM_PORTAL", text: "", attachments: [], audio_url: null, meta: {}, ts: "", ...o });

test("classifies by prefix and extension", () => {
  expect(classifyArtifact("portal_form_RXS-1_T1.html")).toMatchObject({ kind: "html", role: "portal_form" });
  expect(classifyArtifact("portal_form_RXS-1_T1.png")).toMatchObject({ kind: "png", role: "portal_form" });
  expect(classifyArtifact("portal_status_RXS-1_T1.html").role).toBe("portal_status");
  expect(classifyArtifact("email_sent_RXS-1_th.txt")).toMatchObject({ kind: "txt", role: "email_sent" });
  expect(classifyArtifact("email_reply_RXS-1_th.txt").role).toBe("email_reply");
  expect(classifyArtifact("fax_reply_T9.pdf").role).toBe("fax_reply");
  expect(classifyArtifact("fax_RXS-1_T9.pdf").role).toBe("fax_out");
  expect(classifyArtifact("appeal_RXS-1.pdf").role).toBe("evidence_pdf");
  expect(classifyArtifact("invoice_number_RXS-1.pdf").role).toBe("wholesaler_doc");
  expect(classifyArtifact("mystery.bin")).toMatchObject({ kind: "other", role: "other" });
});

test("urls are encoded", () => {
  expect(artifactUrl("a b.pdf")).toBe("/api/artifacts/a%20b.pdf");
});

test("evidence text lists statute, completeness, fields and attachments", () => {
  const t = evidenceText(ev);
  expect(t).toContain("Statute: TN 56-7-3105");
  expect(t).not.toContain("RXS-1\n");
  expect(t).toContain("Completeness: 100%");
  expect(t).toContain("claim id, invoice number");
  expect(t).toContain("  - appeal_RXS-1.pdf");
});

test("limitText truncates long text only", () => {
  expect(limitText("abc", 5)).toEqual({ text: "abc", truncated: false });
  expect(limitText("abcdefg", 5)).toEqual({ text: "abcde", truncated: true });
});

test("artifacts map to evidence, door, decision and refile nodes", () => {
  const view: ClaimView = {
    claim, evidence: ev, actions: [{ kind: "REFILED" }],
    decisions: [
      { claim_id: "RXS-1", ticket_id: "T1", status: "DENIED", reason: "missing_field", field: "invoice_number", delta: null, raw: "need invoice" },
      { claim_id: "RXS-1", ticket_id: "T2", status: "APPROVED", reason: null, field: null, delta: 4, raw: null },
    ],
  };
  const model = { taken: new Set(), rounds: [{ n: 1, decision: view.decisions[0]!, nodes: ["denied_1", "missing_field_1", "refile_mf_1"] as never }] };
  const msgs = [
    msg({ attachments: [...ev.attachments, "portal_form_RXS-1_T1.html", "portal_form_RXS-1_T1.png"], meta: { ticket_id: "T1", form: { claim_id: "RXS-1" } } }),
    msg({ direction: "in", text: "need invoice", attachments: ["portal_status_RXS-1_T1.html"], meta: { ticket_id: "T1" } }),
    msg({ channel: "whatsapp", counterparty: "wholesaler", direction: "in", text: "Attached: invoice number INV-1", attachments: ["invoice_number_RXS-1.pdf"] }),
    msg({ attachments: ["portal_form_RXS-1_T2.html"], meta: { ticket_id: "T2", form: { invoice_number: "INV-1" } } }),
    msg({ direction: "in", text: "approved", attachments: ["portal_status_RXS-1_T2.html"], meta: { ticket_id: "T2" } }),
    msg({ claim_id: "RXS-2", attachments: ["portal_form_RXS-2_T1.html"] }),
  ];
  const a = nodeArtifacts(model as never, view, msgs);
  expect(a.evidence?.map((i) => i.type)).toEqual(["text", "file", "file"]);
  const door = a.door_portal!.filter((i) => i.type === "file").map((i) => (i as { name: string }).name);
  expect(door).toEqual(["portal_form_RXS-1_T1.html", "portal_form_RXS-1_T1.png"]);
  expect(a.door_portal!.some((i) => i.type === "fields")).toBe(true);
  expect(a.denied_1?.map((i) => i.type)).toEqual(["file", "text"]);
  expect(a.approved_2?.[0]).toMatchObject({ type: "file", name: "portal_status_RXS-1_T2.html" });
  expect(a.refile_mf_1?.map((i) => i.type)).toEqual(["file", "fields"]);
  expect(a.missing_field_1?.[0]).toMatchObject({ type: "file", role: "wholesaler_doc" });
  expect(JSON.stringify(a)).not.toContain("RXS-2");
});

test("an emailed appeal shows the letter snapshot and no separate fields table", () => {
  const view: ClaimView = { claim, evidence: ev, actions: [], decisions: [] };
  const model = { taken: new Set(), rounds: [] };
  const msgs = [msg({ channel: "email", attachments: ["email_sent_RXS-1_EML-1.txt"], meta: { ticket_id: "EML-1", fields: { ndc: "1" } } })];
  const a = nodeArtifacts(model as never, view, msgs);
  const items = a.door_email ?? a.door ?? [];
  expect(items.map((i) => i.type)).toEqual(["file"]);
  expect(items[0]).toMatchObject({ role: "email_sent", label: "Email we sent" });
});

test("fax and email replies attach to the decision node without a raw text duplicate", () => {
  const view: ClaimView = {
    claim, evidence: ev, actions: [],
    decisions: [{ claim_id: "RXS-1", ticket_id: "F1", status: "DENIED", reason: "disputed", field: null, delta: null, raw: "no" }],
  };
  const model = { taken: new Set(), rounds: [] };
  const a = nodeArtifacts(model as never, view, [
    msg({ channel: "fax", attachments: ["fax_RXS-1.pdf"], meta: { ticket_id: "F1" } }),
    msg({ channel: "fax", direction: "in", attachments: ["fax_reply_F1.pdf"], meta: { ticket_id: "F1" } }),
    msg({ channel: "email", direction: "in", attachments: ["email_reply_RXS-1_F1.txt"], meta: { ticket_id: "F1" } }),
  ]);
  expect(a.door_fax?.[0]).toMatchObject({ role: "fax_out" });
  expect(a.denied_1?.map((i) => (i as { role: string }).role)).toEqual(["fax_reply"]);
  expect(a.decision_2?.map((i) => (i as { role: string }).role)).toEqual(["email_reply"]);
});

test("a refile that keeps the ticket id still pairs each reply with its own round", () => {
  const view: ClaimView = {
    claim, evidence: ev, actions: [{ kind: "REFILED" }],
    decisions: [
      { claim_id: "RXS-1", ticket_id: "T1", status: "DENIED", reason: "missing_field", field: "invoice_number", delta: null, raw: "Denied: invoice number missing" },
      { claim_id: "RXS-1", ticket_id: "T1", status: "APPROVED", reason: null, field: null, delta: 4, raw: "Approved after review" },
    ],
  };
  const model = { taken: new Set(), rounds: [{ n: 1, decision: view.decisions[0]!, nodes: ["denied_1", "missing_field_1", "refile_mf_1"] as never }] };
  const a = nodeArtifacts(model as never, view, [
    msg({ meta: { ticket_id: "T1", form: { a: "1" } }, attachments: ["portal_form_RXS-1_T1.html"] }),
    msg({ direction: "in", text: "Denied: invoice number missing", meta: { ticket_id: "T1" }, attachments: ["portal_status_RXS-1_T1_r1.html"] }),
    msg({ meta: { ticket_id: "T1", form: { a: "2" } }, attachments: ["portal_form_RXS-1_T1_r2.html"] }),
    msg({ direction: "in", text: "Approved after review", meta: { ticket_id: "T1" }, attachments: ["portal_status_RXS-1_T1_r2.html"] }),
  ]);
  const texts = (id: "denied_1" | "approved_2") => (a[id] ?? []).filter((i) => i.type === "text").map((i) => (i as { text: string }).text);
  expect(texts("denied_1")).toEqual(["Denied: invoice number missing"]);
  expect(texts("approved_2")).toEqual(["Approved after review"]);
  expect((a.denied_1 ?? []).some((i) => i.type === "file" && i.name.endsWith("_r1.html"))).toBe(true);
  expect((a.approved_2 ?? []).some((i) => i.type === "file" && i.name.endsWith("_r2.html"))).toBe(true);
});
