import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/index.js";
import { createApiKey } from "../src/auth.js";
import { resetBuckets } from "../src/ratelimit.js";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";

let app: FastifyInstance;
let db: DatabaseSync;
let key: string;

beforeEach(async () => {
  resetBuckets();
  const built = await buildApp(":memory:");
  app = built.app;
  db = built.db;
  await app.ready();
  key = createApiKey(db, "test", ["admin"]).raw;
});

afterEach(async () => {
  await app.close();
});

function auth() {
  return { authorization: `Bearer ${key}` };
}

async function postJson(url: string, body: unknown) {
  const res = await app.inject({
    method: "POST",
    url,
    headers: { ...auth(), "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

function ledgerSum(): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE -amount END),0) AS s FROM ledger_entries")
    .get() as { s: number };
  return row.s;
}

interface BatchResult {
  index: number;
  ok: boolean;
  status_code: number;
  error?: string;
  payment?: { id: string; status: string };
}

async function makeWallets() {
  const w1 = await postJson("/v1/wallets", { agent_id: "a1", name: "w1", per_tx_cap: 5000, daily_cap: 20000, weekly_cap: 100000 });
  const w2 = await postJson("/v1/wallets", { agent_id: "a2", name: "w2" });
  await postJson(`/v1/wallets/${w1.body.id}/fund`, { amount: 100000 });
  return [w1.body.id as string, w2.body.id as string];
}

describe("batch payments", () => {
  it("runs a mixed batch item by item and reports every outcome", async () => {
    const [w1, w2] = await makeWallets();
    const w3 = await postJson("/v1/wallets", { agent_id: "a3", name: "w3" });
    const res = await postJson("/v1/payments/batch", {
      payments: [
        { from_wallet: w1, to_wallet: w2, amount: 1000, memo: "fine" },
        { from_wallet: w1, to_wallet: w2, amount: 9000, memo: "over the per-tx cap" },
        { from_wallet: w1, to_wallet: w2, amount: -5, memo: "bad amount" },
        { from_wallet: w3.body.id, to_wallet: w1, amount: 500, memo: "no funds" },
        { from_wallet: w1, to_wallet: "w_nope", amount: 100, memo: "ghost" },
      ],
    });
    expect(res.status).toBe(200);
    const results = res.body.results as BatchResult[];
    expect(results.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
    expect(results[0].ok).toBe(true);
    expect(results[0].payment!.status).toBe("completed");
    expect(results[1].ok).toBe(true);
    expect(results[1].payment!.status).toBe("pending_approval");
    expect(results[2].ok).toBe(false);
    expect(results[2].status_code).toBe(400);
    expect(results[3].ok).toBe(false);
    expect(results[3].status_code).toBe(402);
    expect(results[4].ok).toBe(false);
    expect(results[4].status_code).toBe(404);
    expect(res.body.summary).toEqual({ total: 5, completed: 1, held: 1, failed: 3 });

    const bal = await app.inject({ method: "GET", url: `/v1/wallets/${w2}`, headers: auth() });
    expect(bal.json().balance_minor).toBe(1000);
    expect(ledgerSum()).toBe(0);
  });

  it("sees earlier items when checking later balances", async () => {
    const [w1, w2] = await makeWallets();
    const res = await postJson("/v1/payments/batch", {
      payments: [
        { from_wallet: w1, to_wallet: w2, amount: 5000 },
        { from_wallet: w2, to_wallet: w1, amount: 5000 },
      ],
    });
    const results = res.body.results as BatchResult[];
    // the second payment only has funds because the first one landed
    expect(results[1].ok).toBe(true);
    expect(results[1].payment!.status).toBe("completed");
  });

  it("honours per-item idempotency keys across submissions", async () => {
    const [w1, w2] = await makeWallets();
    const batch = { payments: [{ from_wallet: w1, to_wallet: w2, amount: 1000, idempotency_key: "b-1" }] };
    const first = await postJson("/v1/payments/batch", batch);
    const second = await postJson("/v1/payments/batch", batch);
    const a = (first.body.results as BatchResult[])[0];
    const b = (second.body.results as BatchResult[])[0];
    expect(a.payment!.id).toBe(b.payment!.id);
    expect(b.status_code).toBe(200);
    const bal = await app.inject({ method: "GET", url: `/v1/wallets/${w2}`, headers: auth() });
    expect(bal.json().balance_minor).toBe(1000);
  });

  it("rejects empty and oversized batches", async () => {
    const [w1, w2] = await makeWallets();
    expect((await postJson("/v1/payments/batch", { payments: [] })).status).toBe(400);
    expect((await postJson("/v1/payments/batch", {})).status).toBe(400);
    const big = { payments: Array.from({ length: 51 }, () => ({ from_wallet: w1, to_wallet: w2, amount: 1 })) };
    expect((await postJson("/v1/payments/batch", big)).status).toBe(400);
  });
});
