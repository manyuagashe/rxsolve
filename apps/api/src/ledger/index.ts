/**
 * Ledger (DESIGN.md section 11). Owner: P1.
 * LEDGER_BACKEND=local  -> LocalLedger (the kill-switch double; tests and offline dev)
 * LEDGER_BACKEND=nessie -> NessieLedger (INF-04)
 * Append-only: corrections are reversing transfers, never edits.
 */
import type { Transfer } from "@rxsolve/contracts";
import { config } from "../config";
import { LocalLedger } from "./local";
import { DEMO_OPENINGS, NessieLedger } from "./nessie";

export interface Ledger {
  ensureAccounts(accountIds: string[]): Promise<void>;
  hasAccount(accountId: string): Promise<boolean>;
  transfer(t: Transfer): Promise<string>; // returns the ledger's transaction id
  balances(): Promise<Record<string, number>>;
}

let ledger: Ledger | null = null;
export function getLedger(): Ledger {
  ledger ??= config.ledgerBackend === "nessie" ? new NessieLedger({ openings: DEMO_OPENINGS }) : new LocalLedger();
  return ledger;
}
export function resetLedger() { ledger = null; }

/** PBM_PORTAL -> PBM-PORTAL (the ledger entity id). */
export const pbmAccount = (pbm: string) => pbm.replaceAll("_", "-");
