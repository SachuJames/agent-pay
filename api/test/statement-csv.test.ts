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

describe("statement csv export", () => {
  it("downloads the statement oldest first with running balances", async () => {
    const w1 = await postJson("/v1/wallets", { agent_id: "a1", name: "w1" });
    const w2 = await postJson("/v1/wallets", { agent_id: "a2", name: "w2" });
    await postJson(`/v1/wallets/${w1.body.id}/fund`, { amount: 100000 });
    await postJson("/v1/payments", { from_wallet: w1.body.id, to_wallet: w2.body.id, amount: 4000, memo: "api credits" });
    await postJson("/v1/payments", { from_wallet: w1.body.id, to_wallet: w2.body.id, amount: 1500, memo: "top up, again" });

    const res = await app.inject({ method: "GET", url: `/v1/wallets/${w1.body.id}/statement.csv`, headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("statement-");

    const lines = res.body.trim().split("\n");
    expect(lines[0]).toBe("id,payment_id,direction,amount_minor,counterparty,memo,balance_after_minor,created_at");
    expect(lines).toHaveLength(4); // header + funding + two payments
    expect(lines[1]).toContain("credit,100000");
    expect(lines[1]).toContain(",100000,");
    expect(lines[2]).toContain("debit,4000");
    expect(lines[2]).toContain("api credits");
    expect(lines[2]).toContain(",96000,");
    // a memo containing a comma is quoted, and the last balance lands on the wallet balance
    expect(lines[3]).toContain('"top up, again"');
    expect(lines[3]).toContain(",94500,");

    const wallet = await app.inject({ method: "GET", url: `/v1/wallets/${w1.body.id}`, headers: auth() });
    expect(wallet.json().balance_minor).toBe(94500);
  });

  it("matches the json statement entries and 404s unknown wallets", async () => {
    const w1 = await postJson("/v1/wallets", { agent_id: "a1", name: "w1" });
    await postJson(`/v1/wallets/${w1.body.id}/fund`, { amount: 5000 });
    const csv = await app.inject({ method: "GET", url: `/v1/wallets/${w1.body.id}/statement.csv`, headers: auth() });
    const json = await app.inject({ method: "GET", url: `/v1/wallets/${w1.body.id}/statement`, headers: auth() });
    expect(csv.body.trim().split("\n")).toHaveLength(json.json().entries.length + 1);
    expect((await app.inject({ method: "GET", url: "/v1/wallets/w_nope/statement.csv", headers: auth() })).statusCode).toBe(404);
  });
});
