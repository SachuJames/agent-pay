import { randomBytes, randomUUID } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { allowlistOf, balanceOf, now, spendSince, withTx } from "./db.js";
import { assertAmount, formatMinor } from "./money.js";
import { requireScope } from "./auth.js";
import { audit } from "./audit.js";
import { emit } from "./webhooks.js";
import { recordFundingPayment, paymentView } from "./payments.js";

export const TREASURY_WALLET_ID = "treasury";

export function ensureTreasury(db: DatabaseSync): void {
  const row = db.prepare("SELECT id FROM wallets WHERE id = ?").get(TREASURY_WALLET_ID);
  if (!row) {
    db.prepare(
      "INSERT INTO wallets (id, agent_id, name, per_tx_cap, daily_cap, weekly_cap, created_at) VALUES (?, 'system', 'Treasury', ?, ?, ?, ?)"
    ).run(TREASURY_WALLET_ID, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, now());
  }
}

function rowToWallet(db: DatabaseSync, row: Record<string, unknown>) {
  return {
    id: row.id,
    agent_id: row.agent_id,
    name: row.name,
    balance: formatMinor(balanceOf(db, row.id as string)),
    balance_minor: balanceOf(db, row.id as string),
    limits: {
      per_tx_cap: row.per_tx_cap,
      daily_cap: row.daily_cap,
      weekly_cap: row.weekly_cap,
    },
    solana_address: row.solana_pubkey,
    evm_address: row.evm_address,
    allowlist: allowlistOf(db, row.id as string),
    frozen: row.frozen_at != null,
    frozen_at: (row.frozen_at as number | null) ?? null,
    created_at: row.created_at,
  };
}

export function isFrozen(db: DatabaseSync, walletId: string): boolean {
  const row = db.prepare("SELECT frozen_at FROM wallets WHERE id = ?").get(walletId) as
    | { frozen_at: number | null }
    | undefined;
  return !!row && row.frozen_at != null;
}

export function registerWalletRoutes(app: FastifyInstance, db: DatabaseSync) {
  // Create a wallet for an agent. A Solana keypair is generated server-side
  // for demo custody so the settlement adapter can sign; the secret never
  // leaves the server. Production would use an HSM or MPC signer instead.
  app.post("/v1/wallets", { preHandler: requireScope("wallets:write") }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      agent_id?: string;
      name?: string;
      per_tx_cap?: number;
      daily_cap?: number;
      weekly_cap?: number;
    };
    if (!body.agent_id || !body.name) {
      reply.code(400).send({ error: "agent_id and name are required" });
      return;
    }
    for (const cap of [body.per_tx_cap, body.daily_cap, body.weekly_cap]) {
      if (cap !== undefined) assertAmount(cap);
    }
    const id = "w_" + randomUUID().slice(0, 8);
    const sol = Keypair.generate();
    const evm = "0x" + randomBytes(20).toString("hex");
    db.prepare(
      "INSERT INTO wallets (id, agent_id, name, per_tx_cap, daily_cap, weekly_cap, solana_pubkey, evm_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      id,
      body.agent_id,
      body.name,
      body.per_tx_cap ?? 100000,
      body.daily_cap ?? 1000000,
      body.weekly_cap ?? 5000000,
      sol.publicKey.toBase58(),
      evm,
      now()
    );
    // demo custody: store secret so the settlement worker can sign
    db.exec(`CREATE TABLE IF NOT EXISTS wallet_secrets (wallet_id TEXT PRIMARY KEY, secret TEXT NOT NULL)`);
    db.prepare("INSERT INTO wallet_secrets (wallet_id, secret) VALUES (?, ?)").run(
      id,
      Buffer.from(sol.secretKey).toString("base64")
    );
    audit(db, req.apiKey.name, "wallet.created", "wallet", id, { agent_id: body.agent_id });
    emit(db, "wallet.created", { wallet_id: id, agent_id: body.agent_id });
    const row = db.prepare("SELECT * FROM wallets WHERE id = ?").get(id) as Record<string, unknown>;
    reply.code(201).send(rowToWallet(db, row));
  });

  app.get("/v1/wallets", { preHandler: requireScope("read") }, async (req) => {
    const q = req.query as { agent_id?: string; limit?: string };
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
    const rows = (
      q.agent_id
        ? db.prepare("SELECT * FROM wallets WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?").all(q.agent_id, limit)
        : db.prepare("SELECT * FROM wallets ORDER BY created_at DESC LIMIT ?").all(limit)
    ) as Record<string, unknown>[];
    return { wallets: rows.map((r) => rowToWallet(db, r)) };
  });

  app.get("/v1/wallets/:id", { preHandler: requireScope("read") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM wallets WHERE id = ?").get((req.params as { id: string }).id) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      reply.code(404).send({ error: "wallet not found" });
      return;
    }
    reply.send(rowToWallet(db, row));
  });

  // Wallet statement: every ledger entry with the running balance after it.
  // The ledger is the source of truth, so the last entry's balance_after
  // always equals the wallet balance.
  app.get("/v1/wallets/:id/statement", { preHandler: requireScope("read") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const q = req.query as { limit?: string; since?: string };
    const limit = Math.min(Number(q.limit ?? 50) || 50, 500);
    const row = db.prepare("SELECT id FROM wallets WHERE id = ?").get(id);
    if (!row) {
      reply.code(404).send({ error: "wallet not found" });
      return;
    }
    const rows = db
      .prepare(
        `SELECT l.id, l.payment_id, l.direction, l.amount, l.created_at, p.memo,
                CASE WHEN l.direction = 'debit' THEN p.to_wallet ELSE p.from_wallet END AS counterparty
         FROM ledger_entries l JOIN payments p ON p.id = l.payment_id
         WHERE l.wallet_id = ? ORDER BY l.id ASC`
      )
      .all(id) as {
      id: number;
      payment_id: string;
      direction: string;
      amount: number;
      created_at: number;
      memo: string;
      counterparty: string;
    }[];
    let running = 0;
    const entries = rows.map((r) => {
      running += r.direction === "credit" ? r.amount : -r.amount;
      return {
        id: r.id,
        payment_id: r.payment_id,
        direction: r.direction,
        amount_minor: r.amount,
        counterparty: r.counterparty,
        memo: r.memo,
        balance_after_minor: running,
        created_at: r.created_at,
      };
    });
    const since = q.since ? Number(q.since) : null;
    const filtered = since ? entries.filter((e) => e.created_at >= since) : entries;
    reply.send({ wallet_id: id, balance_minor: balanceOf(db, id), entries: filtered.slice(-limit).reverse() });
  });

  // How much of each spending window is used up right now. The same numbers
  // the payment path enforces, so what you see here is what a payment sees.
  app.get("/v1/wallets/:id/limits", { preHandler: requireScope("read") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = db.prepare("SELECT * FROM wallets WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) {
      reply.code(404).send({ error: "wallet not found" });
      return;
    }
    const dailySpent = spendSince(db, id, 24 * 3600 * 1000);
    const weeklySpent = spendSince(db, id, 7 * 24 * 3600 * 1000);
    reply.send({
      wallet_id: id,
      per_tx_cap_minor: row.per_tx_cap,
      daily: {
        cap_minor: row.daily_cap,
        spent_minor: dailySpent,
        remaining_minor: Math.max(0, (row.daily_cap as number) - dailySpent),
      },
      weekly: {
        cap_minor: row.weekly_cap,
        spent_minor: weeklySpent,
        remaining_minor: Math.max(0, (row.weekly_cap as number) - weeklySpent),
      },
    });
  });

  app.patch("/v1/wallets/:id/limits", { preHandler: requireScope("wallets:write") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { per_tx_cap?: number; daily_cap?: number; weekly_cap?: number };
    const row = db.prepare("SELECT * FROM wallets WHERE id = ?").get(id);
    if (!row) {
      reply.code(404).send({ error: "wallet not found" });
      return;
    }
    const updates: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(body)) {
      if (!["per_tx_cap", "daily_cap", "weekly_cap"].includes(k)) continue;
      assertAmount(v);
      updates.push(`${k} = ?`);
      vals.push(v);
    }
    if (updates.length === 0) {
      reply.code(400).send({ error: "no valid limit fields" });
      return;
    }
    db.prepare(`UPDATE wallets SET ${updates.join(", ")} WHERE id = ?`).run(...vals, id);
    audit(db, req.apiKey.name, "wallet.limits_updated", "wallet", id, body);
    const updated = db.prepare("SELECT * FROM wallets WHERE id = ?").get(id) as Record<string, unknown>;
    reply.send(rowToWallet(db, updated));
  });

  // Recipient allowlist: while a wallet has one, it can only pay wallets on
  // the list. An empty list means no restriction. Setting the list replaces
  // it wholesale, so what you PUT is exactly what is enforced afterwards.
  app.get("/v1/wallets/:id/allowlist", { preHandler: requireScope("read") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = db.prepare("SELECT id FROM wallets WHERE id = ?").get(id);
    if (!row) {
      reply.code(404).send({ error: "wallet not found" });
      return;
    }
    reply.send({ wallet_id: id, recipients: allowlistOf(db, id) });
  });

  app.put("/v1/wallets/:id/allowlist", { preHandler: requireScope("wallets:write") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { recipients?: unknown };
    const row = db.prepare("SELECT id FROM wallets WHERE id = ?").get(id);
    if (!row) {
      reply.code(404).send({ error: "wallet not found" });
      return;
    }
    if (!Array.isArray(body.recipients) || body.recipients.some((r) => typeof r !== "string")) {
      reply.code(400).send({ error: "recipients must be an array of wallet ids" });
      return;
    }
    const recipients = [...new Set(body.recipients as string[])];
    if (recipients.includes(id)) {
      reply.code(400).send({ error: "a wallet cannot allowlist itself" });
      return;
    }
    for (const r of recipients) {
      if (!db.prepare("SELECT id FROM wallets WHERE id = ?").get(r)) {
        reply.code(400).send({ error: `unknown recipient wallet: ${r}` });
        return;
      }
    }
    withTx(db, () => {
      db.prepare("DELETE FROM wallet_allowlists WHERE wallet_id = ?").run(id);
      const t = now();
      for (const r of recipients) {
        db.prepare("INSERT INTO wallet_allowlists (wallet_id, recipient_id, created_at) VALUES (?, ?, ?)").run(id, r, t);
      }
    });
    audit(db, req.apiKey.name, "wallet.allowlist_updated", "wallet", id, { recipients });
    emit(db, "wallet.allowlist_updated", { wallet_id: id, recipients });
    reply.send({ wallet_id: id, recipients: allowlistOf(db, id) });
  });

  // Freeze or unfreeze a wallet. A frozen wallet cannot send payments and
  // its held payments cannot be approved until it is unfrozen; receiving
  // money stays allowed, so a freeze never traps other people's funds.
  for (const action of ["freeze", "unfreeze"] as const) {
    app.post(`/v1/wallets/:id/${action}`, { preHandler: requireScope("wallets:write") }, async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const row = db.prepare("SELECT * FROM wallets WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (!row) {
        reply.code(404).send({ error: "wallet not found" });
        return;
      }
      const frozen = row.frozen_at != null;
      if ((action === "freeze") === frozen) {
        reply.send(rowToWallet(db, row));
        return;
      }
      db.prepare("UPDATE wallets SET frozen_at = ? WHERE id = ?").run(action === "freeze" ? now() : null, id);
      audit(db, req.apiKey.name, action === "freeze" ? "wallet.frozen" : "wallet.unfrozen", "wallet", id, {});
      emit(db, action === "freeze" ? "wallet.frozen" : "wallet.unfrozen", { wallet_id: id });
      const updated = db.prepare("SELECT * FROM wallets WHERE id = ?").get(id) as Record<string, unknown>;
      reply.send(rowToWallet(db, updated));
    });
  }

  // Fund a wallet from the treasury (test/dev helper, keeps double-entry intact).
  app.post("/v1/wallets/:id/fund", { preHandler: requireScope("wallets:write") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { amount?: number; memo?: string };
    assertAmount(body.amount);
    const wallet = db.prepare("SELECT id FROM wallets WHERE id = ?").get(id);
    if (!wallet) {
      reply.code(404).send({ error: "wallet not found" });
      return;
    }
    const idem = `fund:${id}:${body.amount}:${(req.headers["idempotency-key"] as string) ?? randomUUID()}`;
    const existing = db.prepare("SELECT id FROM payments WHERE idempotency_key = ?").get(idem) as
      | { id: string }
      | undefined;
    if (existing) {
      const p = db.prepare("SELECT * FROM payments WHERE id = ?").get(existing.id);
      reply.send(paymentView(p as Record<string, unknown>));
      return;
    }
    const payment = {
      id: "pay_" + randomUUID().slice(0, 12),
      from: TREASURY_WALLET_ID,
      to: id,
      amount: body.amount as number,
      memo: body.memo ?? "treasury funding",
      idempotencyKey: idem,
    };
    recordFundingPayment(db, payment, req.apiKey.name);
    const p = db.prepare("SELECT * FROM payments WHERE id = ?").get(payment.id);
    reply.code(201).send(paymentView(p as Record<string, unknown>));
  });
}
