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

async function postJson(url: string, body: unknown = {}) {
  const res = await app.inject({
    method: "POST",
    url,
    headers: { ...auth(), "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

interface AuditPage {
  audit: { id: number; actor: string; action: string; created_at: number }[];
  total: number;
  limit: number;
  offset: number;
}

async function getAudit(qs: string) {
  const res = await app.inject({ method: "GET", url: `/v1/audit?${qs}`, headers: auth() });
  return res.json() as AuditPage;
}

async function seed() {
  const w1 = await postJson("/v1/wallets", { agent_id: "a1", name: "w1" });
  const w2 = await postJson("/v1/wallets", { agent_id: "a2", name: "w2" });
  await postJson(`/v1/wallets/${w1.body.id}/fund`, { amount: 50000 });
  await postJson("/v1/payments", { from_wallet: w1.body.id, to_wallet: w2.body.id, amount: 1000 });
  await postJson(`/v1/wallets/${w2.body.id}/freeze`, {});
  return { w1: w1.body.id as string, w2: w2.body.id as string };
}

describe("audit log querying", () => {
  it("filters by action and by actor", async () => {
    await seed();
    const frozen = await getAudit("action=wallet.frozen");
    expect(frozen.total).toBe(1);
    expect(frozen.audit[0].action).toBe("wallet.frozen");

    const byActor = await getAudit("actor=test");
    expect(byActor.total).toBeGreaterThan(0);
    expect(byActor.audit.every((a) => a.actor === "test")).toBe(true);

    const none = await getAudit("actor=nobody");
    expect(none.total).toBe(0);
    expect(none.audit).toHaveLength(0);
  });

  it("filters by time window", async () => {
    await seed();
    const all = await getAudit("limit=200");
    const newest = all.audit[0].created_at;
    const windowed = await getAudit(`since=${newest + 1}`);
    expect(windowed.total).toBe(0);
    const upTo = await getAudit(`until=${newest}`);
    expect(upTo.total).toBe(all.total);
  });

  it("pages with limit and offset and reports the total", async () => {
    await seed();
    const all = await getAudit("limit=200");
    expect(all.total).toBeGreaterThanOrEqual(5);
    const page1 = await getAudit("limit=2");
    const page2 = await getAudit("limit=2&offset=2");
    expect(page1.audit).toHaveLength(2);
    expect(page2.audit).toHaveLength(2);
    expect(page2.total).toBe(all.total);
    const ids = new Set([...page1.audit, ...page2.audit].map((a) => a.id));
    expect(ids.size).toBe(4);
    // newest first, and page 2 continues where page 1 stopped
    expect(page1.audit[0].id).toBeGreaterThan(page1.audit[1].id);
    expect(page1.audit[1].id).toBeGreaterThan(page2.audit[0].id);
  });
});
