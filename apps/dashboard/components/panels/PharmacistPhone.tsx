"use client";
/** Pharmacist digest trigger (UI-04). The demo phone is a real device; this only sends the digest. */
import { useState } from "react";
import { CheckCircle2, Send, XCircle } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { deliveryState } from "@/lib/delivery";

type Feedback = { kind: "success" | "error"; text: string };

export function PharmacistPhone() {
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  async function sendDigest() {
    if (pending) return;
    setPending(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/digest", { method: "POST" });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(detail || `Request failed with status ${response.status}.`);
      }
      // The response is the recorded ChannelMessage; meta.delivered says what Spectrum did.
      const body = await response.json().catch(() => null) as { meta?: Record<string, unknown> } | null;
      const state = deliveryState(body?.meta);
      setFeedback({
        kind: state.kind === "dashboard-only" ? "error" : "success",
        text: state.kind === "delivered" ? "Delivered to the phone."
          : state.kind === "dashboard-only" ? "Not delivered (dashboard only)."
            : "Simulated phone: nothing was sent to a real device.",
      });
    } catch (error) {
      setFeedback({ kind: "error", text: error instanceof Error ? error.message : "The request failed. Please try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <Panel
      id="phone"
      title="Pharmacist digest"
      subtitle="One text a day to the pharmacist's phone"
      bare
      className="digest"
      aside={
        <button className="btn-gloss" type="button" onClick={() => void sendDigest()} disabled={pending}>
          <Send aria-hidden="true" />
          {pending ? "Sending…" : "Send today's digest"}
        </button>
      }
    >
      {feedback && (
        <p className={`feedback feedback--${feedback.kind}`} role={feedback.kind === "error" ? "alert" : "status"}>
          {feedback.kind === "success" ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />}
          {feedback.text}
        </p>
      )}
    </Panel>
  );
}
