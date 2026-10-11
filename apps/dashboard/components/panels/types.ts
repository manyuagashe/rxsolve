import type { LiveState } from "@/lib/state";

export type PanelProps = { live: LiveState & { connected: boolean } };
const fmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Dollars with thousands separators; a negative keeps its sign in front of the dollar sign. */
export const usd = (n: number | null | undefined) => (n == null ? "—" : `${n < 0 ? "-" : ""}$${fmt.format(Math.abs(n))}`);
