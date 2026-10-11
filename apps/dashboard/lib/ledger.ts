/** Display helpers for the ledger panel. Balances themselves always come from the API. */
export type AccountInfo = { name: string; role: string; /** Who holds it, in words (PBMs are mocks "modeled on"). */ holder: string };

const HOLDERS: Record<string, string> = {
  "PH-MEADOWBROOK": "Meadowbrook Pharmacy",
  "RXSOLVE-PLATFORM": "RxSolve Platform (25% fee)",
  "PBM-PORTAL": "Caremark-style portal",
  "PBM-EMAIL": "Express Scripts-style inbox",
  "PBM-FAX": "OptumRx-style fax line",
};

export function accountInfo(key: string): AccountInfo {
  const upper = key.toUpperCase();
  const holder = HOLDERS[upper] ?? key;
  if (upper.startsWith("PBM")) return { name: "PBM account", role: "pays the remittance", holder };
  if (upper.includes("PLATFORM") || upper.includes("RXSOLVE")) return { name: "Platform account", role: "contingency fee", holder };
  if (upper.startsWith("PH-") || upper.includes("PHARMACY")) return { name: "Pharmacy account", role: "receives the recovery", holder };
  return { name: key, role: "", holder };
}

/** Pharmacy and platform first, then the PBMs, then anything unexpected. */
export function accountOrder(keys: string[]): string[] {
  const rank = (k: string) => (k.startsWith("PH-") ? 0 : k.includes("PLATFORM") ? 1 : k.startsWith("PBM") ? 2 : 3);
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Signed change in cents-safe dollars; null when either side is unknown. */
export function balanceChange(current: number | undefined, baseline: number | undefined): number | null {
  if (typeof current !== "number" || typeof baseline !== "number") return null;
  return Math.round((current - baseline) * 100) / 100;
}
