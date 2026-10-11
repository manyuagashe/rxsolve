/**
 * Capital One Nessie Classic v1 ledger (INF-04).
 *
 * The logical RxSolve actors live as Checking accounts under one sandbox customer. Each account is
 * found by its nickname on startup, so repeated boots do not create duplicate customers/accounts.
 * Nessie uses the API key as a query parameter; never include the request URL in an error message.
 * Domain values are dollars; Nessie amounts and balances are integer cents, converted at this boundary.
 * Classic v1 has no transfer create route, so a transfer is a withdrawal followed by a deposit.
 * The sandbox never updates an account's `balance` field after deposits or withdrawals (verified live), so that
 * field is only the opening balance; balances() adds the account's completed deposits and subtracts its
 * completed withdrawals, all read back from Nessie.
 */
import type { Transfer } from "@rxsolve/contracts";
import type { Ledger } from "./index";
import { config } from "../config";

type JsonObject = Record<string, unknown>;
type NessieFetch = (input: URL, init?: RequestInit) => Promise<Response>;
type NessieOptions = {
  key?: string;
  baseUrl?: string;
  version?: string;
  openingBalance?: number;
  /** Per-account opening balances by logical id; accounts not listed fall back to `openingBalance`. */
  openings?: Record<string, number>;
  fetch?: NessieFetch;
};

const DEFAULT_BASE_URL = "https://api.nessieisreal.com";
const DEFAULT_OPENING_BALANCE = 100_000;
/** Demo openings: a pharmacy operating account, a small platform account, and large payer accounts. */
export const DEMO_OPENINGS: Record<string, number> = {
  "PH-MEADOWBROOK": 48_250,
  "RXSOLVE-PLATFORM": 12_000,
  "PBM-PORTAL": 2_000_000,
  "PBM-EMAIL": 2_000_000,
  "PBM-FAX": 2_000_000,
};
// Earlier customers ("RxSolve Demo", "RxSolve Ledger") hold accounts opened at the single $100,000 balance and
// rehearsal transactions. A new customer name gives fresh accounts at the per-account openings below.
const SANDBOX_CUSTOMER = { first_name: "RxSolve", last_name: "Ledger2" };

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function unwrapObject(value: unknown): JsonObject | null {
  const object = asObject(value);
  if (!object) return null;
  return asObject(object.objectCreated) ?? asObject(object.data) ?? asObject(object.customer)
    ?? asObject(object.account) ?? object;
}

/** Converts dollars to integer cents, or returns null when the value is not a positive whole-cent amount. */
function toCents(dollars: number): number | null {
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  const value = Math.round(dollars * 100);
  return value > 0 && Math.abs(dollars * 100 - value) < 1e-6 ? value : null;
}

function asRecords(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.map(asObject).filter((item): item is JsonObject => item !== null);
  const object = asObject(value);
  if (!object) return [];
  for (const key of ["data", "results", "customers", "accounts"]) {
    if (Array.isArray(object[key])) return asRecords(object[key]);
  }
  return [];
}

function entityId(value: unknown): string | null {
  const object = unwrapObject(value);
  const id = object?._id ?? object?.id;
  return typeof id === "string" && id !== "" ? id : null;
}

function displayName(value: unknown): string {
  if (typeof value === "string") return value.trim().slice(0, 300);
  const object = asObject(value);
  if (!object) return "";
  for (const key of ["message", "error_message", "detail", "error"]) {
    if (typeof object[key] === "string") return String(object[key]).slice(0, 300);
  }
  const errors = object.errors ?? object.validation_errors ?? object.details;
  if (Array.isArray(errors)) {
    return errors.map((entry) => {
      const item = asObject(entry);
      if (!item) return typeof entry === "string" ? entry : "";
      const field = item.field ?? item.param ?? item.path;
      const message = item.message ?? item.error ?? item.reason;
      if (typeof message === "string") return `${typeof field === "string" ? `${field}: ` : ""}${message}`;
      return JSON.stringify(item);
    }).filter(Boolean).join("; ").slice(0, 300);
  }
  return JSON.stringify(object).slice(0, 300);
}

export class NessieLedger implements Ledger {
  private readonly key: string;
  private readonly baseUrl: string;
  private readonly version: string;
  private readonly openingBalance: number;
  private readonly openings: Record<string, number>;
  private readonly fetcher: NessieFetch;
  private customerId: string | null = null;
  private readonly accountIds = new Map<string, string>();

  constructor(options: NessieOptions = {}) {
    this.key = options.key ?? config.nessieKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.version = options.version ?? config.nessieVersion;
    this.openingBalance = options.openingBalance ?? DEFAULT_OPENING_BALANCE;
    this.openings = options.openings ?? {};
    this.fetcher = options.fetch ?? fetch;
  }

  private requireClassicCredentials(): void {
    if (this.version !== "v1") throw new Error(`Unsupported Nessie version: ${this.version}; only classic v1 is implemented`);
    if (!this.key) throw new Error("NESSIE_KEY is required when LEDGER_BACKEND=nessie");
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    this.requireClassicCredentials();
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("key", this.key);
    const method = init.method ?? "GET";
    let response: Response;
    try {
      response = await this.fetcher(url, init);
    } catch {
      throw new Error(`Nessie ${method} ${path} could not be reached`);
    }

    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      const detail = displayName(body).replaceAll(this.key, "[redacted]");
      throw new Error(`Nessie ${method} ${path} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return body;
  }

  private async listCustomers(): Promise<JsonObject[]> {
    return asRecords(await this.request("/customers"));
  }

  private async ensureCustomer(): Promise<string> {
    if (this.customerId) return this.customerId;
    const find = (customers: JsonObject[]) => customers.find((customer) =>
      String(customer.first_name ?? "").toLowerCase() === SANDBOX_CUSTOMER.first_name.toLowerCase()
      && String(customer.last_name ?? "").toLowerCase() === SANDBOX_CUSTOMER.last_name.toLowerCase(),
    );
    let existing = find(await this.listCustomers());
    let id = entityId(existing);
    if (!id) {
      const created = await this.request("/customers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...SANDBOX_CUSTOMER,
          address: { street_number: "1", street_name: "RxSolve Way", city: "Durham", state: "NC", zip: "27701" },
          phone_number: "5550100000",
        }),
      });
      id = entityId(created);
      if (!id) id = entityId(find(await this.listCustomers()));
    }
    if (!id) throw new Error("Nessie did not return the RxSolve sandbox customer id");
    this.customerId = id;
    return id;
  }

  async ensureAccounts(ids: string[]): Promise<void> {
    const uniqueIds = [...new Set(ids.filter((id) => id.trim() !== ""))];
    if (uniqueIds.length === 0) return;
    this.requireClassicCredentials();
    const customerId = await this.ensureCustomer();
    let accounts = asRecords(await this.request(`/customers/${encodeURIComponent(customerId)}/accounts`));

    for (const logicalId of uniqueIds) {
      if (this.accountIds.has(logicalId)) continue;
      let remoteId = entityId(accounts.find((account) => account.nickname === logicalId));
      if (!remoteId) {
        const created = await this.request(`/customers/${encodeURIComponent(customerId)}/accounts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "Checking",
            nickname: logicalId,
            rewards: 0,
            balance: Math.round((this.openings[logicalId] ?? this.openingBalance) * 100),
          }),
        });
        remoteId = entityId(created);
        if (!remoteId) {
          accounts = asRecords(await this.request(`/customers/${encodeURIComponent(customerId)}/accounts`));
          remoteId = entityId(accounts.find((account) => account.nickname === logicalId));
        }
      }
      if (!remoteId) throw new Error(`Nessie did not return an account id for ${logicalId}`);
      this.accountIds.set(logicalId, remoteId);
    }
  }

  async hasAccount(id: string): Promise<boolean> {
    return this.accountIds.has(id);
  }

  async transfer(transfer: Transfer): Promise<string> {
    this.requireClassicCredentials();
    const from = this.accountIds.get(transfer.from);
    const to = this.accountIds.get(transfer.to);
    if (!from || !to) throw new Error(`Nessie account mapping missing for ${!from ? transfer.from : transfer.to}`);
    const amountCents = toCents(transfer.amount);
    if (amountCents === null) throw new Error("Nessie transfer amount must be a positive finite dollar amount in whole cents");
    if (transfer.kind === "opening") throw new Error("Nessie opening balances are created with their accounts");

    const payload = JSON.stringify({
      medium: "balance",
      // Live Nessie rejects a deposit without status (HTTP 400), and stores a withdrawal without one as a record
      // that later breaks GET /accounts/{id}/withdrawals. "completed" is what moves the balance.
      status: "completed",
      transaction_date: new Date().toISOString().slice(0, 10),
      amount: amountCents,
      description: transfer.memo ?? `${transfer.kind}: ${transfer.from} to ${transfer.to}`,
    });
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: payload };

    const withdrawal = await this.request(`/accounts/${encodeURIComponent(from)}/withdrawals`, init);
    const withdrawalId = entityId(withdrawal);
    if (!withdrawalId) throw new Error("Nessie withdrawal response did not include a transaction id");
    let depositId: string | null;
    try {
      depositId = entityId(await this.request(`/accounts/${encodeURIComponent(to)}/deposits`, init));
      if (!depositId) throw new Error("deposit response did not include a transaction id");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      throw new Error(
        `Nessie transfer half-posted: withdrawal ${withdrawalId} of ${amountCents} cents from ${transfer.from} succeeded but the deposit to ${transfer.to} failed (${reason}); manual reconciliation required`,
      );
    }
    return `${withdrawalId}:${depositId}`;
  }

  async balances(): Promise<Record<string, number>> {
    this.requireClassicCredentials();
    const completedCents = async (remoteId: string, kind: "deposits" | "withdrawals") =>
      asRecords(await this.request(`/accounts/${encodeURIComponent(remoteId)}/${kind}`))
        .filter((tx) => tx.status === "completed")
        .reduce((sum, tx) => sum + Number(tx.amount ?? 0), 0);
    const entries = await Promise.all([...this.accountIds].map(async ([logicalId, remoteId]) => {
      const [account, deposits, withdrawals] = await Promise.all([
        this.request(`/accounts/${encodeURIComponent(remoteId)}`).then(unwrapObject),
        completedCents(remoteId, "deposits"),
        completedCents(remoteId, "withdrawals"),
      ]);
      const balance = Number(account?.balance) + deposits - withdrawals;
      if (!Number.isFinite(balance)) throw new Error(`Nessie account ${logicalId} returned an invalid balance`);
      return [logicalId, balance / 100] as const;
    }));
    return Object.fromEntries(entries);
  }
}
