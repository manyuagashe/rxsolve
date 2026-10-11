"use client";
/** Ledger panel (UI-03). Owner: P3. Account balances and their change since load; totals live in the header hero. */
import { useEffect, useRef, useState } from "react";
import type { LedgerSummary } from "@rxsolve/contracts";
import { Panel } from "@/components/ui/Panel";
import { accountInfo, accountOrder, balanceChange } from "@/lib/ledger";
import { useCountUp } from "@/lib/useCountUp";
import { type PanelProps, usd } from "./types";

const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : "+"}${usd(Math.abs(n))}`;

function Balance({ value }: { value: number }) {
  const shown = useCountUp(value);
  return <span className="money account__balance">{usd(shown)}</span>;
}

export function LedgerPanel({ live }: PanelProps) {
  // GET /api/ledger fills the panel before the first settlement emits ledger.balances.
  const [fetched, setFetched] = useState<LedgerSummary | null>(null);
  const [source, setSource] = useState("");
  const baseline = useRef<LedgerSummary | null>(null);

  useEffect(() => {
    fetch("/api/ledger").then((r) => r.json()).then((s: LedgerSummary) => setFetched(s)).catch(() => {});
    fetch("/api/health").then((r) => r.json()).then((h: { ledger?: string }) =>
      setSource(h.ledger === "nessie" ? "Balances from Capital One Nessie" : "Source: local ledger")).catch(() => {});
  }, []);

  const ledger = live.ledger ?? fetched;
  if (ledger && !baseline.current) baseline.current = fetched ?? ledger;

  return (
    <Panel id="ledger" title="Ledger" aside={<span className="label-tracked">Since this page loaded</span>} bare className="ledger">
      {!ledger ? <p className="empty">Waiting for balances…</p> : (
        <ul className="plain accounts">
          {accountOrder(Object.keys(ledger.balances)).map((key) => {
            const balance = ledger.balances[key];
            const info = accountInfo(key);
            const change = balanceChange(balance, baseline.current?.balances[key]);
            const tone = change && change > 0 ? "up" : change && change < 0 ? "down" : "flat";
            return (
              <li className="account" key={key}>
                <div>
                  <strong>{info.role ? `${info.name} · ${info.role}` : info.name}</strong>
                  <small className="muted">{info.holder}</small>
                </div>
                <div className="account__right">
                  {typeof balance === "number" && Number.isFinite(balance) ? <Balance value={balance} /> : <span className="money">—</span>}
                  <span key={`${key}-${change}`} className={`money account__change account__change--${tone}`}>
                    {change === null ? "" : signed(change)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {source && <p className="caption">{source}</p>}
    </Panel>
  );
}
