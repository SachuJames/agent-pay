import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/index.js";
import { createApiKey } from "../src/auth.js";
import { resetBuckets } from "../src/ratelimit.js";
import { signPayload, verifySignature, drainWebhooks } from "../src/webhooks.js";
import { add, sub, formatMinor, parseMajor } from "../src/money.js";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";

let app: FastifyInstance;
let db: DatabaseSync;
let key: string;

async function boot() {
  const built = await buildApp(":memory:");
  app = built.app;
  db = built.db;
  await app.ready();
  const { raw } = createApiKey(db, "test", ["admin"]);
  key = raw;
}

function auth(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${key}`, ...extra };
}

async function reqJson(method: string, url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method, url, headers: { ...auth(), "content-type": "application/json", ...headers }, payload: JSON.stringify(body) });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  return reqJson("POST", url, body, headers);
}

async function patchJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  return reqJson("PATCH", url, body, headers);
}

async function makeWallets() {
  const w1 = await postJson("/v1/wallets", { agent_id: "a1", name: "w1", per_tx_cap: 5000, daily_cap: 20000, weekly_cap: 100000 });
  const w2 = await postJson("/v1/wallets", { agent_id: "a2", name: "w2" });
  await postJson(`/v1/wallets/${w1.body.id}/fund`, { amount: 100000 });
  return [w1.body.id as string, w2.body.id as string];
}

function ledgerSum(): number {
  const row = db.prepare("SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE -amount END),0) AS s FROM ledger_entries").get() as { s: number };
  return row.s;
}

beforeEach(async () => {
  resetBuckets();
  await boot();
});

afterEach(async () => {
  await app.close();
});

describe("money", () => {
  it("rejects overflow and underflow", () => {
    expect(() => add(Number.MAX_SAFE_INTEGER, 1)).toThrow("overflow");
    expect(() => sub(5, 10)).toThrow("underflow");
    expect(() => add(1.5, 2)).toThrow("invalid amount");
  });
  it("formats and parses", () => {
    expect(formatMinor(1999)).toBe("19.99");
    expect(parseMajor("19.99")).toBe(1999);
    expect(() => parseMajor("abc")).toThrow();
  });
});

describe("wallets", () => {
  it("creates wallets with solana and evm addresses and funds them", async () => {
    const [w1] = await makeWallets();
    const res = await app.inject({ method: "GET", url: `/v1/wallets/${w1}`, headers: auth() });
    const w = res.json() as Record<string, unknown>;
    expect(w.balance).toBe("1000.00");
    expect(w.solana_address).toBeTruthy();
    expect((w.evm_address as string).startsWith("0x")).toBe(true);
  });

  it("updates spending limits", async () => {
    const [w1] = await makeWallets();
    const res = await patchJson(`/v1/wallets/${w1}/limits`, { per_tx_cap: 7000 });
    expect(res.status).toBe(200);
    expect((res.body.limits as Record<string, number>).per_tx_cap).toBe(7000);
  });
});

describe("payments", () => {
  it("completes in-limit payments and conserves money", async () => {
    const [w1, w2] = await makeWallets();
    const r = await postJson("/v1/payments", { from_wallet: w1, to_wallet: w2, amount: 3000 }, { "Idempotency-Key": "k1" });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("completed");
    expect(ledgerSum()).toBe(0);
  });

  it("holds over-limit payments for approval with a reason code", async () => {
    const [w1, w2] = await makeWallets();
    const r = await postJson("/v1/payments", { from_wallet: w1, to_wallet: w2, amount: 8000 });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe("pending_approval");
    expect(r.body.reason_code).toBe("per_tx_cap");
    const q = await app.inject({ method: "GET", url: "/v1/approvals/pending", headers: auth() });
    expect((q.json() as { pending: unknown[] }).pending).toHaveLength(1);
  });

  it("enforces the daily cap across multiple payments", async () => {
    const [w1, w2] = await makeWallets();
    // per-tx 5000, daily 20000: four 5000 payments exhaust the daily cap
    for (let i = 0; i < 4; i++) {
      const r = await postJson("/v1/payments", { from_wallet: w1, to_wallet: w2, amount: 5000 });
      expect(r.body.status).toBe("completed");
    }
    const r = await postJson("/v1/payments", { from_wallet: w1, to_wallet: w2, amount: 1000 });
    expect(r.body.status).toBe("pending_approval");
    expect(r.body.reason_code).toBe("daily_cap");
  });

  it("rejects payments with insufficient funds", async () => {
    const [w1, w2] = await makeWallets();
    const r = await postJson("/v1/payments", { from_wallet: w2, to_wallet: w1, amount: 100 });
    expect(r.status).toBe(402);
  });

  it("is idempotent on the idempotency key", async () => {
    const [w1, w2] = await makeWallets();
    const b1 = await postJson("/v1/payments", { from_wallet: w1, to_wallet: w2, amount: 1000 }, { "Idempotency-Key": "dup" });
    const b2 = await postJson("/v1/payments", { from_wallet: w1, to_wallet: w2, amount: 1000 }, { "Idempotency-Key": "dup" });
    expect(b1.body.id).toBe(b2.body.id);
    const bal = await app.inject({ method: "GET", url: `/v1/wallets/${w1}`, headers: auth() });
    expect((bal.json() as Record<string, unknown>).balance).toBe("990.00");
  });
});

describe("approvals", () => {
  it("approves a held payment and moves the money", async () => {
    const [w1, w2] = await makeWallets();
    const held = await postJson("/v1/payments", { from_wallet: w1, to_wallet: w2, amount: 8000 });
    const ok = await postJson(`/v1/approvals/${held.body.id}/approve`, { reason_code: "manager_ok" });
    expect(ok.body.status).toBe("completed");
    expect(ok.body.reason_code).toBe("manager_ok");
    const bal = await app.inject({ method: "GET", url: `/v1/wallets/${w2}`, headers: auth() });
    expect((bal.json() as Record<string, unknown>).balance).toBe("80.00");
    expect(ledgerSum()).toBe(0);
  });

  it("rejects a held payment without moving money", async () => {
    const [w1, w2] = await makeWallets();
    const held = await postJson("/v1/payments", { from_wallet: w1, to_wallet: w2, amount: 8000 });
    const rej = await postJson(`/v1/approvals/${held.body.id}/reject`, { reason_code: "suspicious" });
    expect(rej.body.status).toBe("rejected");
    const bal = await app.inject({ method: "GET", url: `/v1/wallets/${w2}`, headers: auth() });
    expect((bal.json() as Record<string, unknown>).balance).toBe("0.00");
  });

  it("fails approval when funds moved while pending", async () => {
    const [w1, w2] = await makeWallets();
    const held = await postJson("/v1/payments", { from_wallet: w1, to_wallet: w2, amount: 8000 });
    // raise caps so the drain actually completes, then spend nearly everything
    await patchJson(`/v1/wallets/${w1}/limits`, { per_tx_cap: 100000, daily_cap: 1000000, weekly_cap: 10000000 });
    for (let i = 0; i < 9; i++) await postJson("/v1/payments", { from_wallet: w1, to_wallet: w2, amount: 10000 });
    await postJson("/v1/payments", { from_wallet: w1, to_wallet: w2, amount: 5000 }); // 95000 spent, 5000 left
    const ok = await postJson(`/v1/approvals/${held.body.id}/approve`, {});
    expect(ok.status).toBe(409);
    const p = await app.inject({ method: "GET", url: `/v1/payments/${held.body.id}`, headers: auth() });
    expect((p.json() as Record<string, unknown>).status).toBe("failed");
  });

  it("refuses to decide a non-pending payment", async () => {
    const [w1, w2] = await makeWallets();
    const done = await postJson("/v1/payments", { from_wallet: w1, to_wallet: w2, amount: 1000 });
    const r = await postJson(`/v1/approvals/${done.body.id}/approve`, {});
    expect(r.status).toBe(409);
  });
});

describe("auth and rate limiting", () => {
  it("rejects missing and invalid keys", async () => {
    const r1 = await app.inject({ method: "GET", url: "/v1/wallets" });
    expect(r1.statusCode).toBe(401);
    const r2 = await app.inject({ method: "GET", url: "/v1/wallets", headers: { authorization: "Bearer bogus" } });
    expect(r2.statusCode).toBe(401);
  });

  it("enforces scopes", async () => {
    const { raw } = createApiKey(db, "readonly", ["read"]);
    const r = await app.inject({
      method: "POST",
      url: "/v1/wallets",
      headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" },
      payload: JSON.stringify({ agent_id: "x", name: "y" }),
    });
    expect(r.statusCode).toBe(403);
  });

  it("rate limits aggressively when configured low", async () => {
    process.env.RATE_LIMIT_MAX = "3";
    const built = await buildApp(":memory:");
    const a2 = built.app;
    await a2.ready();
    const { raw } = createApiKey(built.db, "t", ["admin"]);
    let limited = 0;
    for (let i = 0; i < 6; i++) {
      const r = await a2.inject({ method: "GET", url: "/v1/wallets", headers: { authorization: `Bearer ${raw}` } });
      if (r.statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
    await a2.close();
    delete process.env.RATE_LIMIT_MAX;
  });
});

describe("webhooks", () => {
  it("signs and verifies payloads", () => {
    const sig = signPayload("secret", "body");
    expect(verifySignature("secret", "body", sig)).toBe(true);
    expect(verifySignature("secret", "body", sig + "x")).toBe(false);
    expect(verifySignature("wrong", "body", sig)).toBe(false);
  });

  it("delivers signed events to subscribed endpoints", async () => {
    const received: { sig: string; body: string }[] = [];
    const server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        received.push({ sig: req.headers["x-agentpay-signature"] as string, body: data });
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;

    const sub = await postJson("/v1/webhooks", { url: `http://127.0.0.1:${port}/hook`, events: ["payment.completed"] });
    expect(sub.status).toBe(201);
    const secret = sub.body.secret as string;

    await makeWallets(); // fund emits payment.completed
    const n = await drainWebhooks(db);
    expect(n).toBeGreaterThan(0);
    expect(received.length).toBeGreaterThan(0);
    const first = received[0];
    expect(verifySignature(secret, first.body, first.sig)).toBe(true);
    expect(JSON.parse(first.body).event).toBe("payment.completed");
    server.close();
  });
});

describe("audit log", () => {
  it("records every state change", async () => {
    const [w1, w2] = await makeWallets();
    await postJson("/v1/payments", { from_wallet: w1, to_wallet: w2, amount: 1000 });
    const res = await app.inject({ method: "GET", url: "/v1/audit?limit=100", headers: auth() });
    const actions = (res.json() as { audit: { action: string }[] }).audit.map((a) => a.action);
    expect(actions).toContain("wallet.created");
    expect(actions).toContain("wallet.funded");
    expect(actions).toContain("payment.completed");
  });
});

describe("evm settlement", () => {
  it("records an honest local settlement", async () => {
    const [w1, w2] = await makeWallets();
    const pay = await postJson("/v1/payments", { from_wallet: w1, to_wallet: w2, amount: 1000 });
    const s = await postJson(`/v1/payments/${pay.body.id}/settle`, { rail: "evm" });
    expect(s.status).toBe(201);
    expect(s.body.status).toBe("recorded");
    expect(s.body.tx_hash).toBeNull();
  });

  it("refuses to settle non-completed payments", async () => {
    const [w1, w2] = await makeWallets();
    const held = await postJson("/v1/payments", { from_wallet: w1, to_wallet: w2, amount: 8000 });
    const s = await postJson(`/v1/payments/${held.body.id}/settle`, { rail: "evm" });
    expect(s.status).toBe(409);
  });
});
