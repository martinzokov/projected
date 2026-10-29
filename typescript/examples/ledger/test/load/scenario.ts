import { OPERATE } from "@projected/application/event-sourced";
import { jwtAuthenticator } from "@projected/auth-jwt";
import { httpHandler } from "@projected/http";
import { randomIds, startPolling, systemClock } from "@projected/runtime";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { HANDLE_CASH, MANAGE_ACCOUNTS } from "../../src/application/port/driving/schemas.js";
import { composeLedger, type LedgerInfrastructure } from "../../src/infrastructure/config/ledger.js";
import { listen, web } from "../../src/infrastructure/config/web.js";

export interface LoadOptions {
  /** The stores to run against: in memory, or PostgreSQL. */
  readonly stores: Pick<LedgerInfrastructure, "eventStore" | "snapshots" | "checkpoints" | "documents" | "idempotency">;
  readonly accounts: number;
  readonly transfers: number;
  /** Requests in flight at once. */
  readonly concurrency: number;
  /** Every account starts with this, in cents. */
  readonly openingBalance?: number;
  readonly onProgress?: (line: string) => void;
}

export interface LoadReport {
  readonly transfers: number;
  readonly completed: number;
  readonly rejected: number;
  /** Requests for `make-transfer` per second, while they were being sent. */
  readonly requestsPerSecond: number;
  /** Latency of `make-transfer` over HTTP, in milliseconds. */
  readonly latency: { readonly p50: number; readonly p95: number; readonly p99: number; readonly max: number };
  /** Transfers carried out per second, from the first request until every one had settled. */
  readonly settledPerSecond: number;
  /** Every invariant that did not hold. None, or the ledger is wrong. */
  readonly violations: readonly string[];
}

const ISSUER = "https://issuer.load.test/";
const AUDIENCE = "https://ledger.load.test";

const percentile = (sorted: readonly number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

/** A source of pseudo-random numbers that replays: the same seed, the same transfers. */
function random(seed: number) {
  let state = seed >>> 0;
  return (below: number) => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state % below;
  };
}

/**
 * Serve the ledger over real HTTP, behind real JWT verification, then fire `transfers` random
 * transfers between `accounts` customers' accounts, `concurrency` at a time, and wait until the
 * background process has carried every one out. Then check what must hold of any ledger: no
 * money created or lost, no account overdrawn, nothing left in flight, every transfer settled.
 */
export async function runLoad(options: LoadOptions): Promise<LoadReport> {
  const progress = options.onProgress ?? (() => {});
  const opening = options.openingBalance ?? 1_000_00;
  const keys = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "load", alg: "ES256" };
  const token = (sub: string, permissions: string[] = []) =>
    new SignJWT({ permissions }).setProtectedHeader({ alg: "ES256", kid: "load" }).setIssuer(ISSUER).setAudience(AUDIENCE).setSubject(sub).setIssuedAt().setExpirationTime("1h").sign(keys.privateKey);

  const app = composeLedger({ ...options.stores, clock: systemClock(), ids: randomIds() });
  const api = httpHandler(app, { authenticator: jwtAuthenticator({ issuer: ISSUER, audience: AUDIENCE, keys: { keys: [jwk] } }) });
  const server = await listen(web(api, { corsOrigins: [] }), 0);
  const poller = startPolling(app, { intervalMs: 20 });

  const staff = await token("staff", [MANAGE_ACCOUNTS, OPERATE]);
  const teller = await token("teller", [HANDLE_CASH]);
  const customers = await Promise.all(Array.from({ length: options.accounts }, (_, index) => token(`customer-${index}`)));
  const call = async (kind: "commands" | "queries", type: string, body: unknown, bearer: string) => {
    const response = await fetch(`${server.url}/${kind}/${type}/version/1`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });
    const answer = (await response.json()) as { status: string; value?: unknown; error?: unknown };
    if (answer.status !== "ok") throw new Error(`${type} answered ${response.status}: ${JSON.stringify(answer)}`);
    return answer.value;
  };
  /** Run `work` for 0..count-1, `concurrency` at a time. */
  const inParallel = async (count: number, work: (index: number) => Promise<void>) => {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(options.concurrency, count) }, async () => {
      while (next < count) await work(next++);
    }));
  };

  try {
    const accountId = (index: number) => `load-${index}`;
    await inParallel(options.accounts, async (index) => {
      await call("commands", "open-account", { accountId: accountId(index), holder: `customer-${index}`, currency: "EUR" }, staff);
      await call("commands", "deposit-money", { accountId: accountId(index), amount: opening, currency: "EUR", reference: "opening" }, teller);
    });
    progress(`opened ${options.accounts} accounts with ${opening / 100} EUR each`);

    const pick = random(42);
    const asked = Array.from({ length: options.transfers }, (_, index) => {
      const from = pick(options.accounts);
      const to = (from + 1 + pick(options.accounts - 1)) % options.accounts;
      return { transferId: `load-t-${index}`, from, to, amount: 1 + pick(200_00) };
    });
    const latencies: number[] = [];
    const started = performance.now();
    await inParallel(asked.length, async (index) => {
      const { transferId, from, to, amount } = asked[index] ?? { transferId: "", from: 0, to: 0, amount: 0 };
      const sent = performance.now();
      await call("commands", "make-transfer", { transferId, from: accountId(from), to: accountId(to), amount, currency: "EUR" }, customers[from] ?? "");
      latencies.push(performance.now() - sent);
      if ((index + 1) % 1000 === 0) progress(`requested ${index + 1} transfers`);
    });
    const requested = performance.now();

    // Settled once no handler has anything left to do.
    for (;;) {
      const backlog = (await app.backlog()).unwrap();
      if (backlog.every((handler) => handler.oldestPending === undefined)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const settled = performance.now();
    progress(`settled ${asked.length} transfers in ${((settled - started) / 1000).toFixed(1)} s`);

    const violations: string[] = [];
    const balances = (await Promise.all(
      Array.from({ length: options.accounts }, (_, index) => call("queries", "account-balance", { accountId: accountId(index) }, staff)),
    )) as Array<{ account: { balance: number; available: number; incoming: number } | null }>;
    const total = balances.reduce((sum, { account }) => sum + (account?.balance ?? 0), 0);
    if (total !== opening * options.accounts) violations.push(`money was created or lost: ${total} in the accounts, ${opening * options.accounts} paid in`);
    balances.forEach(({ account }, index) => {
      if (account === null) violations.push(`${accountId(index)} is missing`);
      else if (account.balance < 0) violations.push(`${accountId(index)} is overdrawn: ${account.balance}`);
      else if (account.available !== account.balance || account.incoming !== 0) violations.push(`${accountId(index)} still has transfers in flight`);
    });
    const statuses = (await Promise.all(asked.map(({ transferId }) => call("queries", "transfer-status", { transferId }, staff)))) as Array<{ transfer: { status: string } | null }>;
    const count = (status: string) => statuses.filter(({ transfer }) => transfer?.status === status).length;
    const unsettled = asked.length - count("completed") - count("rejected");
    if (unsettled > 0) violations.push(`${unsettled} transfers did not complete or get rejected`);

    const sorted = [...latencies].sort((a, b) => a - b);
    return {
      transfers: asked.length,
      completed: count("completed"),
      rejected: count("rejected"),
      requestsPerSecond: asked.length / ((requested - started) / 1000),
      latency: { p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted.at(-1) ?? 0 },
      settledPerSecond: asked.length / ((settled - started) / 1000),
      violations,
    };
  } finally {
    await poller.stop();
    await server.close();
  }
}
