import { expect, test } from "bun:test";
import type { Transfer } from "@rxsolve/contracts";
import { DEMO_OPENINGS, NessieLedger } from "../src/ledger/nessie";

type Json = Record<string, unknown>;
type Fetcher = (input: URL, init?: RequestInit) => Promise<Response>;

function fakeNessie() {
  const customers: Json[] = [];
  const accounts = new Map<string, Json>();
  const requests: { method: string; path: string; key: string | null; body: Json | null }[] = [];
  let customerSequence = 0;
  let accountSequence = 0;
  let failDeposits = false;
  let transactionSequence = 0;
  const transactions: { account: string; kind: string; amount: number; status: unknown }[] = [];

  const fetcher: Fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const path = decodeURIComponent(url.pathname);
    const body = typeof init.body === "string" ? JSON.parse(init.body) as Json : null;
    requests.push({ method, path, key: url.searchParams.get("key"), body });

    if (path === "/customers" && method === "GET") return Response.json(customers);
    if (path === "/customers" && method === "POST") {
      const customer = { ...body, _id: `customer-${++customerSequence}` };
      customers.push(customer);
      return Response.json(customer, { status: 201 });
    }

    const customerAccounts = path.match(/^\/customers\/([^/]+)\/accounts$/);
    if (customerAccounts && method === "GET") {
      return Response.json([...accounts.values()].filter((account) => account.customer_id === customerAccounts[1]));
    }
    if (customerAccounts && method === "POST") {
      const account = { ...body, _id: `account-${++accountSequence}`, customer_id: customerAccounts[1] };
      accounts.set(String(account._id), account);
      return Response.json(account, { status: 201 });
    }

    const accountPath = path.match(/^\/accounts\/([^/]+)$/);
    if (accountPath && method === "GET") {
      const account = accounts.get(accountPath[1]!);
      return account ? Response.json(account) : Response.json({ message: "unknown account" }, { status: 404 });
    }

    const txPath = path.match(/^\/accounts\/([^/]+)\/(withdrawals|deposits)$/);
    if (txPath && method === "GET") {
      return Response.json(transactions.filter((tx) => tx.account === txPath[1] && tx.kind === txPath[2]));
    }
    if (txPath && method === "POST") {
      const account = accounts.get(txPath[1]!);
      if (!account) return Response.json({ message: "unknown account" }, { status: 404 });
      if (failDeposits && txPath[2] === "deposits") return Response.json({ message: "deposit rejected" }, { status: 500 });
      if (!body?.status) return Response.json(`1 validation error for DepositCreate\nstatus\n  field required`, { status: 400 }); // as live Nessie
      const amount = Number(body?.amount);
      // Like live Nessie: the account's balance field never changes; the transaction is only recorded.
      transactions.push({ account: txPath[1]!, kind: txPath[2]!, amount, status: body.status });
      const id = `${txPath[2] === "withdrawals" ? "wd" : "dep"}-${++transactionSequence}`;
      return Response.json({ code: 201, message: "Created", objectCreated: { _id: id } }, { status: 201 });
    }
    return Response.json({ message: `unexpected ${method} ${path}` }, { status: 404 });
  };

  return { fetcher, requests, accounts, customers, failDeposits: (v: boolean) => { failDeposits = v; } };
}

const ids = ["PH-MEADOWBROOK", "PBM-PORTAL", "RXSOLVE-PLATFORM"];
const options = (fake: ReturnType<typeof fakeNessie>) => ({
  key: "test-key", baseUrl: "https://nessie.test", version: "v1", fetch: fake.fetcher,
});

test("classic v1 account setup is idempotent and transfers/balances use mapped account ids", async () => {
  const fake = fakeNessie();
  const ledger = new NessieLedger(options(fake));

  await ledger.ensureAccounts(ids);
  expect(fake.customers).toHaveLength(1);
  expect(fake.accounts.size).toBe(3);
  expect(await ledger.hasAccount("PH-MEADOWBROOK")).toBe(true);
  expect(await ledger.hasAccount("PATIENT-UNKNOWN")).toBe(false);

  const transfer: Transfer = {
    from: "PBM-PORTAL", to: "PH-MEADOWBROOK", amount: 6.4,
    kind: "remittance_adjustment", memo: "REM-1 remittance adjustment RXS-1",
  };
  expect(await ledger.transfer(transfer)).toBe("wd-1:dep-2");
  expect(await ledger.balances()).toEqual({
    "PH-MEADOWBROOK": 100006.4,
    "PBM-PORTAL": 99993.6,
    "RXSOLVE-PLATFORM": 100000,
  });

  await ledger.ensureAccounts(ids);
  const reopened = new NessieLedger(options(fake));
  await reopened.ensureAccounts(ids);
  expect(fake.customers).toHaveLength(1);
  expect(fake.accounts.size).toBe(3);
  expect(fake.requests.filter((request) => request.method === "POST" && request.path === "/customers")).toHaveLength(1);
  expect(fake.requests.filter((request) => request.method === "POST" && request.path.endsWith("/accounts"))).toHaveLength(3);
  expect(fake.requests.every((request) => request.key === "test-key")).toBe(true);
  const posts = fake.requests.filter((request) => request.method === "POST" && /\/(withdrawals|deposits)$/.test(request.path));
  expect(posts.map((request) => request.path)).toEqual(["/accounts/account-2/withdrawals", "/accounts/account-1/deposits"]);
  expect(posts[0]!.body).toMatchObject({ medium: "balance", amount: 640, description: "REM-1 remittance adjustment RXS-1" });
  expect(posts[0]!.body?.transaction_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(fake.requests.some((request) => request.path.endsWith("/transfers"))).toBe(false);
});

test("a missing key fails before making a Nessie request", async () => {
  let called = false;
  const ledger = new NessieLedger({ key: "", version: "v1", fetch: async () => {
    called = true;
    return Response.json([]);
  } });

  await expect(ledger.ensureAccounts(["PH-MEADOWBROOK"])).rejects.toThrow("NESSIE_KEY is required");
  expect(called).toBe(false);
});

test("HTTP errors are actionable without leaking the API key", async () => {
  const apiKey = "sensitive-test-key";
  const ledger = new NessieLedger({
    key: apiKey,
    version: "v1",
    baseUrl: "https://nessie.test",
    fetch: async () => Response.json({ message: `invalid key ${apiKey}` }, { status: 401 }),
  });

  const failure = await ledger.ensureAccounts(["PH-MEADOWBROOK"]).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("HTTP 401");
  expect((failure as Error).message).not.toContain(apiKey);
  expect((failure as Error).message).toContain("[redacted]");
});

test("nested Nessie validation errors are exposed without leaking credentials", async () => {
  const apiKey = "nested-sensitive-key";
  const ledger = new NessieLedger({
    key: apiKey,
    version: "v1",
    baseUrl: "https://nessie.test",
    fetch: async () => Response.json({ errors: [{ field: "status", message: `invalid value for ${apiKey}` }] }, { status: 400 }),
  });

  const failure = await ledger.ensureAccounts(["PH-MEADOWBROOK"]).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("HTTP 400");
  expect((failure as Error).message).toContain("status: invalid value for [redacted]");
  expect((failure as Error).message).not.toContain(apiKey);
});

test("invalid transfer amounts are rejected before posting", async () => {
  const fake = fakeNessie();
  const ledger = new NessieLedger(options(fake));
  await ledger.ensureAccounts(ids);
  const base = { from: "PBM-PORTAL", to: "PH-MEADOWBROOK", kind: "remittance_adjustment" } as const;
  for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.005, 0.001]) {
    await expect(ledger.transfer({ ...base, amount })).rejects.toThrow("positive finite");
  }
  expect(fake.requests.filter((request) => /\/(withdrawals|deposits)$/.test(request.path))).toHaveLength(0);
});

test("opening balances are sent as integer cents and balances return dollars", async () => {
  const fake = fakeNessie();
  const ledger = new NessieLedger({ ...options(fake), openingBalance: 100_000 });
  await ledger.ensureAccounts(["PH-MEADOWBROOK"]);
  const create = fake.requests.find((request) => request.method === "POST" && request.path.endsWith("/accounts"))!;
  expect(create.body?.balance).toBe(10_000_000);
  expect(await ledger.balances()).toEqual({ "PH-MEADOWBROOK": 100_000 });
});

test("demo openings give each actor its own balance and unlisted ids fall back", async () => {
  const fake = fakeNessie();
  const ledger = new NessieLedger({ ...options(fake), openings: DEMO_OPENINGS, openingBalance: 5_000 });
  await ledger.ensureAccounts(["PH-MEADOWBROOK", "RXSOLVE-PLATFORM", "PBM-PORTAL", "OTHER"]);
  expect(await ledger.balances()).toEqual({
    "PH-MEADOWBROOK": 48_250, "RXSOLVE-PLATFORM": 12_000, "PBM-PORTAL": 2_000_000, OTHER: 5_000,
  });
});

test("fractional cents survive a settlement-shaped transfer pair", async () => {
  const fake = fakeNessie();
  const ledger = new NessieLedger(options(fake));
  await ledger.ensureAccounts(ids);
  const fee = Math.round(12.34 * 0.25 * 100) / 100;
  await ledger.transfer({ from: "PBM-PORTAL", to: "PH-MEADOWBROOK", amount: 12.34, kind: "remittance_adjustment" });
  await ledger.transfer({ from: "PH-MEADOWBROOK", to: "RXSOLVE-PLATFORM", amount: fee, kind: "contingency_fee" });
  const amounts = fake.requests.filter((request) => request.path.endsWith("/withdrawals")).map((request) => request.body?.amount);
  expect(amounts).toEqual([1234, Math.round(fee * 100)]);
  expect(await ledger.balances()).toEqual({
    "PH-MEADOWBROOK": (10_000_000 + 1234 - Math.round(fee * 100)) / 100,
    "PBM-PORTAL": (10_000_000 - 1234) / 100,
    "RXSOLVE-PLATFORM": (10_000_000 + Math.round(fee * 100)) / 100,
  });
});

test("a failed deposit after a successful withdrawal names the half-posted state and is not retried", async () => {
  const fake = fakeNessie();
  const ledger = new NessieLedger(options(fake));
  await ledger.ensureAccounts(ids);
  fake.failDeposits(true);
  const failure = await ledger.transfer({
    from: "PH-MEADOWBROOK", to: "RXSOLVE-PLATFORM", amount: 1.6, kind: "contingency_fee",
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  const message = (failure as Error).message;
  expect(message).toContain("half-posted");
  expect(message).toContain("PH-MEADOWBROOK");
  expect(message).toContain("160 cents");
  expect(message).toContain("wd-1");
  expect(message).not.toContain("test-key");
  expect(fake.requests.filter((request) => request.path.endsWith("/withdrawals"))).toHaveLength(1);
  expect(fake.requests.filter((request) => request.path.endsWith("/deposits"))).toHaveLength(1);
});
