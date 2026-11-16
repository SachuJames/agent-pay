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

async function reqJson(method: string, url: string, body: unknown = {}) {
  const res = await app.inject({
    method,
    url,
    headers: { ...auth(), "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function makeWallets() {
  const ids: string[] = [];
  for (const n of ["w1", "w2", "w3"]) {
    const w = await reqJson("POST", "/v1/wallets", { agent_id: n, name: n });
    ids.push(w.body.id as string);
  }
  await reqJson("POST", `/v1/wallets/${ids[0]}/fund`, { amount: 100000 });
  return ids;
}

describe("recipient allowlist", () => {
  it("starts empty and unrestricted, then restricts payments to listed wallets", async () => {
    const [w1, w2, w3] = await makeWallets();
    const before = await app.inject({ method: "GET", url: `/v1/wallets/${w1}/allowlist`, headers: auth() });
    expect(before.json().recipients).toEqual([]);
    expect((await reqJson("POST", "/v1/payments", { from_wallet: w1, to_wallet: w3, amount: 1000 })).status).toBe(201);

    const put = await reqJson("PUT", `/v1/wallets/${w1}/allowlist`, { recipients: [w2] });
    expect(put.status).toBe(200);
    expect(put.body.recipients).toEqual([w2]);

    expect((await reqJson("POST", "/v1/payments", { from_wallet: w1, to_wallet: w2, amount: 1000 })).status).toBe(201);
    const blocked = await reqJson("POST", "/v1/payments", { from_wallet: w1, to_wallet: w3, amount: 1000 });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toContain("allowlist");

    // the wallet view carries the list too
    const view = await app.inject({ method: "GET", url: `/v1/wallets/${w1}`, headers: auth() });
    expect(view.json().allowlist).toEqual([w2]);
  });

  it("replaces the list wholesale and clearing it lifts the restriction", async () => {
    const [w1, w2, w3] = await makeWallets();
    await reqJson("PUT", `/v1/wallets/${w1}/allowlist`, { recipients: [w2] });
    const replaced = await reqJson("PUT", `/v1/wallets/${w1}/allowlist`, { recipients: [w3] });
    expect(replaced.body.recipients).toEqual([w3]);
    expect((await reqJson("POST", "/v1/payments", { from_wallet: w1, to_wallet: w2, amount: 1000 })).status).toBe(403);
    expect((await reqJson("POST", "/v1/payments", { from_wallet: w1, to_wallet: w3, amount: 1000 })).status).toBe(201);

    const cleared = await reqJson("PUT", `/v1/wallets/${w1}/allowlist`, { recipients: [] });
    expect(cleared.body.recipients).toEqual([]);
    expect((await reqJson("POST", "/v1/payments", { from_wallet: w1, to_wallet: w2, amount: 1000 })).status).toBe(201);
  });

  it("validates the list and the wallet", async () => {
    const [w1, w2] = await makeWallets();
    expect((await reqJson("PUT", `/v1/wallets/${w1}/allowlist`, { recipients: ["w_nope"] })).status).toBe(400);
    expect((await reqJson("PUT", `/v1/wallets/${w1}/allowlist`, { recipients: [w1] })).status).toBe(400);
    expect((await reqJson("PUT", `/v1/wallets/${w1}/allowlist`, { recipients: "w2" })).status).toBe(400);
    expect((await reqJson("PUT", "/v1/wallets/w_nope/allowlist", { recipients: [w2] })).status).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/wallets/w_nope/allowlist", headers: auth() })).statusCode).toBe(404);
  });

  it("never blocks a refund back to the original sender", async () => {
    const [w1, w2, w3] = await makeWallets();
    const pay = await reqJson("POST", "/v1/payments", { from_wallet: w1, to_wallet: w2, amount: 4000 });
    expect(pay.status).toBe(201);
    // w2 may now only pay w3, but the refund route back to w1 must still work
    await reqJson("PUT", `/v1/wallets/${w2}/allowlist`, { recipients: [w3] });
    const refund = await reqJson("POST", `/v1/payments/${pay.body.id}/refund`, {});
    expect(refund.status).toBe(201);
  });

  it("writes an audit row when the list changes", async () => {
    const [w1, w2] = await makeWallets();
    await reqJson("PUT", `/v1/wallets/${w1}/allowlist`, { recipients: [w2] });
    const res = await app.inject({
      method: "GET",
      url: `/v1/audit?action=wallet.allowlist_updated&entity_id=${w1}`,
      headers: auth(),
    });
    expect(res.json().total).toBe(1);
  });
});
