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

async function getJson(url: string) {
  const res = await app.inject({ method: "GET", url, headers: auth() });
  return res.json() as { payments: Record<string, unknown>[]; total: number; limit: number; offset: number };
}

async function seed() {
  const w1 = await postJson("/v1/wallets", { agent_id: "a1", name: "w1", per_tx_cap: 5000, daily_cap: 20000, weekly_cap: 100000 });
  const w2 = await postJson("/v1/wallets", { agent_id: "a2", name: "w2" });
  await postJson(`/v1/wallets/${w1.body.id}/fund`, { amount: 100000 });
  for (let i = 0; i < 5; i++) {
    await postJson("/v1/payments", { from_wallet: w1.body.id, to_wallet: w2.body.id, amount: 1000 + i });
  }
  return { w1: w1.body.id as string, w2: w2.body.id as string };
}

describe("payments list filtering and paging", () => {
  it("reports the total and pages with limit and offset", async () => {
    await seed();
    // 5 payments plus the funding payment
    const page1 = await getJson("/v1/payments?limit=2");
    expect(page1.total).toBe(6);
    expect(page1.payments).toHaveLength(2);
    expect(page1.limit).toBe(2);
    expect(page1.offset).toBe(0);
    const page2 = await getJson("/v1/payments?limit=2&offset=2");
    expect(page2.payments).toHaveLength(2);
    const ids = new Set([...page1.payments, ...page2.payments].map((p) => p.id));
    expect(ids.size).toBe(4);
    const last = await getJson("/v1/payments?limit=2&offset=4");
    expect(last.payments).toHaveLength(2);
    const beyond = await getJson("/v1/payments?limit=2&offset=6");
    expect(beyond.payments).toHaveLength(0);
    expect(beyond.total).toBe(6);
  });

  it("filters by created_at window", async () => {
    const { w1 } = await seed();
    const all = await getJson(`/v1/payments?wallet_id=${w1}`);
    expect(all.total).toBe(6);
    const newest = all.payments[0].created_at as number;
    const oldest = all.payments[all.payments.length - 1].created_at as number;

    const afterOldest = await getJson(`/v1/payments?since=${oldest + 1}`);
    expect(afterOldest.total).toBeLessThan(6);
    expect(afterOldest.payments.every((p) => (p.created_at as number) > oldest)).toBe(true);

    const beforeNewest = await getJson(`/v1/payments?until=${newest - 1}`);
    expect(beforeNewest.payments.every((p) => (p.created_at as number) < newest)).toBe(true);

    const exact = await getJson(`/v1/payments?since=${oldest}&until=${oldest}`);
    expect(exact.total).toBeGreaterThanOrEqual(1);
    expect(exact.payments.every((p) => p.created_at === oldest)).toBe(true);
  });

  it("combines date filters with status and wallet filters", async () => {
    const { w1, w2 } = await seed();
    const held = await postJson("/v1/payments", { from_wallet: w1, to_wallet: w2, amount: 9000 });
    expect(held.status).toBe(202);
    const res = await getJson(`/v1/payments?wallet_id=${w2}&status=pending_approval&since=0`);
    expect(res.total).toBe(1);
    expect(res.payments[0].id).toBe(held.body.id);
  });
});
