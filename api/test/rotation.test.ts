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

function auth(k = key) {
  return { authorization: `Bearer ${k}` };
}

async function postAs(k: string, url: string, body: unknown = {}) {
  const res = await app.inject({
    method: "POST",
    url,
    headers: { ...auth(k), "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

describe("api key rotation", () => {
  it("hands out a working replacement and kills the old key", async () => {
    const created = await postAs(key, "/v1/api-keys", { name: "svc", scopes: ["read", "payments:write"] });
    expect(created.status).toBe(201);
    const oldRaw = created.body.key as string;

    const rotated = await postAs(key, `/v1/api-keys/${created.body.id}/rotate`);
    expect(rotated.status).toBe(201);
    expect(rotated.body.rotated_from).toBe(created.body.id);
    expect(rotated.body.name).toBe("svc");
    expect(rotated.body.scopes).toEqual(["read", "payments:write"]);
    const newRaw = rotated.body.key as string;
    expect(newRaw).not.toBe(oldRaw);

    const oldUse = await app.inject({ method: "GET", url: "/v1/wallets", headers: auth(oldRaw) });
    expect(oldUse.statusCode).toBe(401);
    const newUse = await app.inject({ method: "GET", url: "/v1/wallets", headers: auth(newRaw) });
    expect(newUse.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/v1/api-keys", headers: auth() });
    const rows = list.json().api_keys as { id: string; revoked_at: number | null }[];
    expect(rows.find((r) => r.id === created.body.id)!.revoked_at).not.toBeNull();
    expect(rows.find((r) => r.id === rotated.body.id)!.revoked_at).toBeNull();
  });

  it("refuses to rotate a revoked key or an unknown one", async () => {
    const created = await postAs(key, "/v1/api-keys", { name: "svc", scopes: ["read"] });
    await postAs(key, `/v1/api-keys/${created.body.id}/revoke`);
    expect((await postAs(key, `/v1/api-keys/${created.body.id}/rotate`)).status).toBe(409);
    expect((await postAs(key, "/v1/api-keys/nope/rotate")).status).toBe(404);
  });

  it("needs admin scope and writes an audit row", async () => {
    const reader = createApiKey(db, "reader", ["read"]);
    const created = await postAs(key, "/v1/api-keys", { name: "svc", scopes: ["read"] });
    expect((await postAs(reader.raw, `/v1/api-keys/${created.body.id}/rotate`)).status).toBe(403);

    await postAs(key, `/v1/api-keys/${created.body.id}/rotate`);
    const res = await app.inject({ method: "GET", url: "/v1/audit?entity=api_key&limit=50", headers: auth() });
    const actions = (res.json().audit as { action: string }[]).map((a) => a.action);
    expect(actions).toContain("apikey.rotated");
  });
});
