"use client";
import { useEffect, useRef, useState } from "react";
import { recoveryClaims } from "@/lib/claims";
import { useCountUp } from "@/lib/useCountUp";
import { type PanelProps, usd } from "@/components/panels/types";

const BURST_MS = 2400;
const REPLAY_GRACE_MS = 1500;

/** Header total: recovered to date from the ledger, plus a short "+$x" burst on each settlement. */
export function Hero({ live }: PanelProps) {
  const recovered = live.ledger?.recovered_to_date ?? 0;
  const fees = live.ledger?.fees_to_date ?? 0;
  const shown = useCountUp(recovered);
  const claims = recoveryClaims(live);
  const settled = claims.filter(({ view }) => view.stage === "SETTLED").length;

  // Totals that arrive while the server replays history are not announced as new settlements.
  const armed = useRef(false);
  useEffect(() => {
    armed.current = false;
    if (!live.connected) return;
    const timer = window.setTimeout(() => { armed.current = true; }, REPLAY_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [live.connected]);

  const previous = useRef<number | null>(null);
  const [burst, setBurst] = useState<string | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = recovered;
    if (before === null || recovered <= before || !armed.current) return;
    setBurst(`+${usd(recovered - before)}`);
    const timer = window.setTimeout(() => setBurst(null), BURST_MS);
    return () => window.clearTimeout(timer);
  }, [recovered]);

  return (
    <section className="hero" aria-label="Total recovered">
      <div>
        <div className="label-tracked hero__label">Recovered to date</div>
        <div className="hero__num money" aria-label={usd(recovered)}>{usd(shown)}</div>
      </div>
      <p className="hero__sub">
        {live.ledger ? (
          <>
            <strong>{settled} of {claims.length} claims recovered</strong>
            <span aria-hidden="true"> · </span>
            fees <span className="money hero__fees">{usd(fees)}</span>
          </>
        ) : "Waiting for ledger balances"}
      </p>
      <div className="hero__burst" role="status" aria-live="polite">{burst}</div>
    </section>
  );
}
