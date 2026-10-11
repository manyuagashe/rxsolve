"use client";
/**
 * Recovered-over-time chart. Owner: P3. Reads GET /api/ledger/series (a TigerData continuous aggregate when the
 * API runs on TigerData) and refetches whenever the ledger moves, so it climbs live during the demo.
 */
import { useEffect, useRef, useState } from "react";
import type { RecoveryPoint } from "@rxsolve/contracts";
import { Panel } from "@/components/ui/Panel";
import { type PanelProps, usd } from "./types";

const PAD = { top: 12, right: 12, bottom: 22, left: 52 };

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** A round axis maximum: 1, 2 or 5 times a power of ten. */
function niceMax(v: number) {
  if (v <= 0) return 10;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

export function RecoveryChart({ live }: PanelProps) {
  const [series, setSeries] = useState<RecoveryPoint[]>([]);
  const [source, setSource] = useState<string>("");
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(480);
  const [H, setH] = useState(300);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then((h) => setSource(h.db === "tigerdata" ? "TigerData continuous aggregate" : "in-memory buckets")).catch(() => {});
  }, []);

  // Every settlement emits ledger.balances, so a new summary means a new point.
  useEffect(() => {
    fetch("/api/ledger/series").then((r) => r.json()).then(setSeries).catch(() => {});
  }, [live.ledger]);

  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => {
      setWidth(Math.max(240, e!.contentRect.width));
      setH(Math.max(120, e!.contentRect.height));
    });
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  let running = 0;
  const points = series.map((p) => ({ ...p, total: (running = Math.round((running + p.recovered) * 100) / 100) }));
  const total = points.at(-1)?.total ?? 0;

  const t0 = points.length ? Date.parse(points[0]!.bucket) : 0;
  const step = points.length > 1 ? Date.parse(points[1]!.bucket) - t0 : 15_000;
  const t1 = points.length ? Date.parse(points.at(-1)!.bucket) + step : 1;
  const yMax = niceMax(total);
  const iw = width - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * iw;
  const y = (v: number) => PAD.top + ih - (v / yMax) * ih;

  // Step line: flat through each bucket, rising at its end to the new running total.
  let d = points.length ? `M${x(t0)},${y(0)}` : "";
  for (const p of points) {
    const end = Date.parse(p.bucket) + step;
    d += ` H${x(end)} V${y(p.total)}`;
  }
  const area = d ? `${d} V${y(0)} Z` : "";
  const ticks = [0, yMax / 2, yMax];
  const h = hover != null ? points[hover] : undefined;

  return (
    <Panel id="chart" title="Recovered over time" aside="each step is a recovery" className="chart">
      <p className="chart__total">
        <strong className="money">{usd(total)}</strong>{" "}
        <span className="muted">across {points.reduce((n, p) => n + p.settlements, 0)} recoveries</span>
      </p>
      <div ref={box} className="chart__plot">
        {!points.length ? <p className="empty" style={{ height: H }}>No recoveries yet.</p> : (
          <svg width={width} height={H} role="img" aria-label={`Cumulative recovered dollars, now ${usd(total)}`} onMouseLeave={() => setHover(null)}>
            {ticks.map((v) => (
              <g key={v}>
                <line className="chart__grid" x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} />
                <text className="chart__tick" x={PAD.left - 6} y={y(v) + 4} textAnchor="end">{usd(v)}</text>
              </g>
            ))}
            <text className="chart__tick" x={PAD.left} y={H - 6}>{clock(points[0]!.bucket)}</text>
            <text className="chart__tick" x={width - PAD.right} y={H - 6} textAnchor="end">{clock(new Date(t1).toISOString())}</text>
            <path className="chart__area" d={area} />
            <path className="chart__line" d={d} />
            {points.map((p, i) => {
              const cx = x(Date.parse(p.bucket) + step);
              return (
                <g key={p.bucket} onMouseEnter={() => setHover(i)}>
                  <rect x={cx - iw / points.length / 2} y={PAD.top} width={iw / points.length} height={ih} fill="transparent" />
                  {hover === i && <line className="chart__guide" x1={cx} x2={cx} y1={PAD.top} y2={PAD.top + ih} />}
                  <circle className="chart__dot" cx={cx} cy={y(p.total)} r={hover === i ? 8 : 6} />
                </g>
              );
            })}
          </svg>
        )}
        {h && (
          <div className="chart__tip" style={{ left: Math.min(x(Date.parse(h.bucket) + step) + 8, width - 190) }}>
            <div>{clock(h.bucket)}</div>
            <div>+<span className="money">{usd(h.recovered)}</span> · {h.settlements} recovered</div>
            <div>Total <span className="money">{usd(h.total)}</span></div>
          </div>
        )}
      </div>
      <p className="caption">Source: {source || "…"}</p>
      <details className="chart__table">
        <summary>Table</summary>
        <table>
          <thead><tr><th align="left">Bucket</th><th align="right">Recovered</th><th align="right">Fees</th><th align="right">Recoveries</th><th align="right">Total</th></tr></thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.bucket}>
                <td>{clock(p.bucket)}</td><td align="right" className="money">{usd(p.recovered)}</td>
                <td align="right" className="money">{usd(p.fees)}</td><td align="right">{p.settlements}</td>
                <td align="right" className="money">{usd(p.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </Panel>
  );
}
