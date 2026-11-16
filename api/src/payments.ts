import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { allowlistOf, balanceOf, now, spendSince, withTx } from "./db.js";
import { assertAmount, formatMinor } from "./money.js";
import { requireScope } from "./auth.js";
import { audit } from "./audit.js";
import { emit } from "./webhooks.js";

export type PaymentStatus = "pending_approval" | "completed" | "rejected" | "failed" | "expired";

/** How long a held payment waits for a decision before it expires. */
export const APPROVAL_TTL_MS = Number(process.env.APPROVAL_TTL_MS ?? 24 * 3600 * 1000);

export function paymentView(p: Record<string, unknown>, refundedMinor = 0) {
  return {
    id: p.id,
    from_wallet: p.from_wallet,
    to_wallet: p.to_wallet,
    amount: formatMinor(p.amount as number),
    amount_minor: p.amount,
    memo: p.memo,
    status: p.status,
    reason_code: p.reason_code,
    refund_of: (p.refund_of as string | null) ?? null,
    refunded_minor: refundedMinor,
    expires_at: (p.expires_at as number | null) ?? null,
    created_at: p.created_at,
    decided_at: p.decided_at,
    decided_by: p.decided_by,
  };
}

/** Total already refunded against a payment (completed refunds only). */
export function refundedTotal(db: DatabaseSync, paymentId: string): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE refund_of = ? AND status = 'completed'")
    .get(paymentId) as { s: number };
  return row.s;
}

export interface NewPayment {
  id: string;
  from: string;
  to: string;
  amount: number;
  memo: string;
  idempotencyKey: string | null;
}

/**
 * Write a completed payment: one debit row and one credit row in a single
 * transaction. Conservation is structural (debit == credit), and the balance
 * check happens inside the same transaction as the insert.
 */
export function writeLedgerEntries(db: DatabaseSync, paymentId: string, from: string, to: string, amount: number): void {
  const t = now();
  db.prepare(
    "INSERT INTO ledger_entries (wallet_id, payment_id, direction, amount, created_at) VALUES (?, ?, 'debit', ?, ?)"
  ).run(from, paymentId, amount, t);
  db.prepare(
    "INSERT INTO ledger_entries (wallet_id, payment_id, direction, amount, created_at) VALUES (?, ?, 'credit', ?, ?)"
  ).run(to, paymentId, amount, t);
}

export function recordCompletedPayment(db: DatabaseSync, p: NewPayment, actor: string): void {
  withTx(db, () => {
    const bal = balanceOf(db, p.from);
    if (bal < p.amount) throw new Error("insufficient funds");
    insertCompletedPayment(db, p, actor);
  });
  audit(db, actor, "payment.completed", "payment", p.id, { from: p.from, to: p.to, amount: p.amount });
  emit(db, "payment.completed", { payment_id: p.id, from_wallet: p.from, to_wallet: p.to, amount: p.amount });
}

function insertCompletedPayment(db: DatabaseSync, p: NewPayment, actor: string): void {
  const t = now();
  db.prepare(
    "INSERT INTO payments (id, from_wallet, to_wallet, amount, memo, status, idempotency_key, created_at, decided_at, decided_by) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)"
  ).run(p.id, p.from, p.to, p.amount, p.memo, p.idempotencyKey, t, t, actor);
  writeLedgerEntries(db, p.id, p.from, p.to, p.amount);
}

/**
 * Treasury funding: mints ledger balance from the treasury wallet, which is
 * allowed to go negative (it is the money printer). Double-entry still holds.
 */
export function recordFundingPayment(db: DatabaseSync, p: NewPayment, actor: string): void {
  withTx(db, () => insertCompletedPayment(db, p, actor));
  audit(db, actor, "wallet.funded", "payment", p.id, { to: p.to, amount: p.amount });
  emit(db, "payment.completed", { payment_id: p.id, from_wallet: p.from, to_wallet: p.to, amount: p.amount });
}

function limitVerdict(
  db: DatabaseSync,
  from: string,
  amount: number
): { ok: true } | { ok: false; reason: string } {
  const w = db.prepare("SELECT per_tx_cap, daily_cap, weekly_cap FROM wallets WHERE id = ?").get(from) as {
    per_tx_cap: number;
    daily_cap: number;
    weekly_cap: number;
  };
  if (amount > w.per_tx_cap) return { ok: false, reason: "per_tx_cap" };
  if (spendSince(db, from, 24 * 3600 * 1000) + amount > w.daily_cap) return { ok: false, reason: "daily_cap" };
  if (spendSince(db, from, 7 * 24 * 3600 * 1000) + amount > w.weekly_cap) return { ok: false, reason: "weekly_cap" };
  return { ok: true };
}

export interface PaymentInput {
  from_wallet?: string;
  to_wallet?: string;
  amount?: number;
  memo?: string;
}

export type CreatePaymentResult =
  | { statusCode: number; payment: Record<string, unknown> }
  | { statusCode: number; errorBody: Record<string, unknown> };

/**
 * Create one payment with the full rule set: validation, frozen and
 * allowlist checks, idempotency, balance, then limits (breach holds the
 * payment for approval instead of failing it). Shared by the single
 * payment route and the batch route so both behave identically.
 */
export function createPayment(
  db: DatabaseSync,
  actor: string,
  body: PaymentInput,
  idemKey: string | null
): CreatePaymentResult {
  if (!body.from_wallet || !body.to_wallet || body.amount === undefined) {
    return { statusCode: 400, errorBody: { error: "from_wallet, to_wallet and amount are required" } };
  }
  if (body.from_wallet === body.to_wallet) {
    return { statusCode: 400, errorBody: { error: "from_wallet and to_wallet must differ" } };
  }
  try {
    assertAmount(body.amount);
  } catch {
    return { statusCode: 400, errorBody: { error: "amount must be a non-negative integer of minor units" } };
  }
  const from = db.prepare("SELECT id, frozen_at FROM wallets WHERE id = ?").get(body.from_wallet) as
    | { id: string; frozen_at: number | null }
    | undefined;
  const to = db.prepare("SELECT id FROM wallets WHERE id = ?").get(body.to_wallet);
  if (!from || !to) {
    return { statusCode: 404, errorBody: { error: "unknown wallet" } };
  }
  if (from.frozen_at != null) {
    return { statusCode: 403, errorBody: { error: "sender wallet is frozen" } };
  }
  // A wallet with a recipient allowlist can only pay wallets on it.
  // Refunds do not pass through here, so an allowlist can never trap
  // money that has to go back.
  const allowlist = allowlistOf(db, body.from_wallet);
  if (allowlist.length > 0 && !allowlist.includes(body.to_wallet)) {
    return { statusCode: 403, errorBody: { error: "recipient is not on the sender wallet allowlist" } };
  }

  // Idempotency: same key returns the original payment, never re-executes.
  if (idemKey) {
    const existing = db.prepare("SELECT * FROM payments WHERE idempotency_key = ?").get(idemKey) as
      | Record<string, unknown>
      | undefined;
    if (existing) {
      return { statusCode: 200, payment: paymentView(existing, refundedTotal(db, existing.id as string)) };
    }
  }

  const id = "pay_" + randomUUID().slice(0, 12);
  const payment: NewPayment = {
    id,
    from: body.from_wallet,
    to: body.to_wallet,
    amount: body.amount,
    memo: body.memo ?? "",
    idempotencyKey: idemKey,
  };

  if (balanceOf(db, payment.from) < payment.amount) {
    return { statusCode: 402, errorBody: { error: "insufficient funds", balance_minor: balanceOf(db, payment.from) } };
  }

  const verdict = limitVerdict(db, payment.from, payment.amount);
  if (!verdict.ok) {
    const t = now();
    db.prepare(
      "INSERT INTO payments (id, from_wallet, to_wallet, amount, memo, status, idempotency_key, created_at, reason_code, expires_at) VALUES (?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?, ?)"
    ).run(id, payment.from, payment.to, payment.amount, payment.memo, idemKey, t, verdict.reason, t + APPROVAL_TTL_MS);
    audit(db, actor, "payment.held_for_approval", "payment", id, {
      reason: verdict.reason,
      amount: payment.amount,
    });
    emit(db, "payment.pending_approval", {
      payment_id: id,
      from_wallet: payment.from,
      to_wallet: payment.to,
      amount: payment.amount,
      reason_code: verdict.reason,
    });
    const p = db.prepare("SELECT * FROM payments WHERE id = ?").get(id);
    return { statusCode: 202, payment: paymentView(p as Record<string, unknown>) };
  }

  try {
    recordCompletedPayment(db, payment, actor);
  } catch (err) {
    return { statusCode: 402, errorBody: { error: String(err instanceof Error ? err.message : err) } };
  }
  const p = db.prepare("SELECT * FROM payments WHERE id = ?").get(id);
  return { statusCode: 201, payment: paymentView(p as Record<string, unknown>) };
}

export function registerPaymentRoutes(app: FastifyInstance, db: DatabaseSync) {
  app.post("/v1/payments", { preHandler: requireScope("payments:write") }, async (req, reply) => {
    const idemKey = (req.headers["idempotency-key"] as string) || null;
    const r = createPayment(db, req.apiKey.name, (req.body ?? {}) as PaymentInput, idemKey);
    if ("errorBody" in r) {
      reply.code(r.statusCode).send(r.errorBody);
      return;
    }
    reply.code(r.statusCode).send(r.payment);
  });

  // Batch submission: each item runs the same rules as a single payment,
  // in order, and one bad item never blocks the rest. Items may carry
  // their own idempotency_key. The response reports every item's outcome.
  app.post("/v1/payments/batch", { preHandler: requireScope("payments:write") }, async (req, reply) => {
    const body = (req.body ?? {}) as { payments?: unknown };
    if (!Array.isArray(body.payments) || body.payments.length === 0) {
      reply.code(400).send({ error: "payments must be a non-empty array" });
      return;
    }
    if (body.payments.length > 50) {
      reply.code(400).send({ error: "batch is limited to 50 payments" });
      return;
    }
    const results = (body.payments as (PaymentInput & { idempotency_key?: string })[]).map((item, index) => {
      const r = createPayment(db, req.apiKey.name, item ?? {}, item?.idempotency_key ?? null);
      if ("errorBody" in r) {
        return { index, ok: false, status_code: r.statusCode, error: r.errorBody.error, balance_minor: r.errorBody.balance_minor };
      }
      return { index, ok: true, status_code: r.statusCode, payment: r.payment };
    });
    const summary = {
      total: results.length,
      completed: results.filter((r) => r.ok && r.payment?.status === "completed").length,
      held: results.filter((r) => r.ok && r.payment?.status === "pending_approval").length,
      failed: results.filter((r) => !r.ok).length,
    };
    reply.send({ results, summary });
  });

  app.get("/v1/payments", { preHandler: requireScope("read") }, async (req) => {
    const q = req.query as {
      wallet_id?: string;
      status?: string;
      since?: string;
      until?: string;
      limit?: string;
      offset?: string;
    };
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
    const conds: string[] = [];
    const vals: (string | number | null)[] = [];
    if (q.wallet_id) {
      conds.push("(from_wallet = ? OR to_wallet = ?)");
      vals.push(q.wallet_id, q.wallet_id);
    }
    if (q.status) {
      conds.push("status = ?");
      vals.push(q.status);
    }
    // since/until are epoch milliseconds, matching created_at elsewhere.
    if (q.since && Number.isFinite(Number(q.since))) {
      conds.push("created_at >= ?");
      vals.push(Number(q.since));
    }
    if (q.until && Number.isFinite(Number(q.until))) {
      conds.push("created_at <= ?");
      vals.push(Number(q.until));
    }
    const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM payments ${where}`).get(...vals) as { n: number }).n;
    const rows = db
      .prepare(`SELECT * FROM payments ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...vals, limit, offset) as Record<string, unknown>[];
    return { payments: rows.map((r) => paymentView(r, refundedTotal(db, r.id as string))), total, limit, offset };
  });

  app.get("/v1/payments/:id", { preHandler: requireScope("read") }, async (req, reply) => {
    const p = db.prepare("SELECT * FROM payments WHERE id = ?").get((req.params as { id: string }).id) as
      | Record<string, unknown>
      | undefined;
    if (!p) {
      reply.code(404).send({ error: "payment not found" });
      return;
    }
    reply.send(paymentView(p, refundedTotal(db, p.id as string)));
  });

  // Refund a completed payment, in full or in part. Refunds run backwards
  // (original recipient pays the sender back) as their own completed payment
  // linked with refund_of; they skip spending caps, since returning money is
  // not spending, but the recipient's balance is still checked, so a refund
  // cannot pull money that is no longer there.
  app.post("/v1/payments/:id/refund", { preHandler: requireScope("payments:write") }, async (req, reply) => {
    const origId = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { amount?: number; memo?: string };
    const orig = db.prepare("SELECT * FROM payments WHERE id = ?").get(origId) as Record<string, unknown> | undefined;
    if (!orig) {
      reply.code(404).send({ error: "payment not found" });
      return;
    }
    const idemKey = (req.headers["idempotency-key"] as string) || null;
    if (idemKey) {
      const existing = db.prepare("SELECT * FROM payments WHERE idempotency_key = ?").get(idemKey) as
        | Record<string, unknown>
        | undefined;
      if (existing) {
        reply.send(paymentView(existing));
        return;
      }
    }
    if (orig.status !== "completed") {
      reply.code(409).send({ error: `only completed payments can be refunded (this one is ${orig.status})` });
      return;
    }
    if (orig.refund_of) {
      reply.code(409).send({ error: "a refund cannot itself be refunded" });
      return;
    }
    const already = refundedTotal(db, origId);
    const remaining = (orig.amount as number) - already;
    const amount = body.amount ?? remaining;
    try {
      assertAmount(amount);
    } catch {
      reply.code(400).send({ error: "amount must be a non-negative integer of minor units" });
      return;
    }
    if (amount <= 0) {
      reply.code(400).send({ error: "amount must be positive" });
      return;
    }
    if (amount > remaining) {
      reply.code(409).send({ error: "refund exceeds the refundable remainder", refundable_minor: remaining });
      return;
    }
    const id = "pay_" + randomUUID().slice(0, 12);
    const refund: NewPayment = {
      id,
      from: orig.to_wallet as string,
      to: orig.from_wallet as string,
      amount,
      memo: body.memo ?? `refund of ${origId}`,
      idempotencyKey: idemKey,
    };
    try {
      withTx(db, () => {
        if (balanceOf(db, refund.from) < amount) throw new Error("insufficient funds");
        const t = now();
        db.prepare(
          "INSERT INTO payments (id, from_wallet, to_wallet, amount, memo, status, idempotency_key, created_at, decided_at, decided_by, refund_of) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)"
        ).run(id, refund.from, refund.to, amount, refund.memo, idemKey, t, t, req.apiKey.name, origId);
        writeLedgerEntries(db, id, refund.from, refund.to, amount);
      });
    } catch (err) {
      reply.code(402).send({ error: String(err instanceof Error ? err.message : err) });
      return;
    }
    audit(db, req.apiKey.name, "payment.refunded", "payment", origId, { refund_id: id, amount });
    emit(db, "payment.refunded", { payment_id: id, refund_of: origId, amount });
    const p = db.prepare("SELECT * FROM payments WHERE id = ?").get(id);
    reply.code(201).send(paymentView(p as Record<string, unknown>));
  });
}
