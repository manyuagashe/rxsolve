import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Loader2, MinusCircle, XCircle } from "lucide-react";
import type { Tone } from "@/lib/claims";

const ICON: Record<Tone, ReactNode> = {
  good: <CheckCircle2 aria-hidden="true" />,
  warn: <AlertTriangle aria-hidden="true" />,
  info: <Loader2 aria-hidden="true" className="spin" />,
  bad: <XCircle aria-hidden="true" />,
  muted: <MinusCircle aria-hidden="true" />,
};

/** Skeuomorphic hex indicator light plus a tracked label: status is never carried by color alone. */
export function Pill({ tone = "muted", big = false, children }: { tone?: Tone; big?: boolean; children: ReactNode }) {
  return (
    <span className={`pill pill--${tone}${big ? " pill--big" : ""}`}>
      <span className={`hex-orb hex-orb--${tone}`} aria-hidden="true">{ICON[tone]}</span>
      <span>{children}</span>
    </span>
  );
}
