import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { balanceOf, now, withTx } from "./db.js";
import { requireScope } from "./auth.js";
import { audit } from "./audit.js";
import { emit } from "./webhooks.js";
import { paymentView, writeLedgerEntries } from "./payments.js";

export function registerApprovalRoutes(app: FastifyInstance, db: DatabaseSync) {

  app.get("/v1/approvals/pending", { preHandler: requireScope("read") }, async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
    const rows = db
      .prepare("SELECT * FROM payments WHERE status = 'pending_approval' ORDER BY created_at ASC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return { pending: rows.map((r) => paymentView(r)) };
  });

  app.post("/v1/approvals/:id/approve", { preHandler: requireScope("approvals:write") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { reason_code?: string };
    const p = db.prepare("SELECT * FROM payments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!p) {
      reply.code(404).send({ error: "payment not found" });
      return;
    }
    if (p.status !== "pending_approval") {
      reply.code(409).send({ error: `payment is ${p.status}, not pending_approval` });
      return;
    }
    // Re-check funds at decision time: money may have moved while pending.
    if (balanceOf(db, p.from_wallet as string) < (p.amount as number)) {
      db.prepare("UPDATE payments SET status='failed', decided_at=?, decided_by=?, reason_code='insufficient_funds' WHERE id = ?").run(
        now(),
        req.apiKey.name,
        id
      );
      audit(db, req.apiKey.name, "payment.approval_failed", "payment", id, { reason: "insufficient_funds" });
      emit(db, "payment.failed", { payment_id: id, reason_code: "insufficient_funds" });
      reply.code(409).send({ error: "insufficient funds at approval time; payment marked failed" });
      return;
    }
    const t = now();
    withTx(db, () => {
      db.prepare("UPDATE payments SET status='completed', decided_at=?, decided_by=?, reason_code=? WHERE id = ?").run(
        t,
        req.apiKey.name,
        body.reason_code ?? "manual_approval",
        id
      );
      writeLedgerEntries(db, id, p.from_wallet as string, p.to_wallet as string, p.amount as number);
    });
    audit(db, req.apiKey.name, "payment.approved", "payment", id, {
      reason_code: body.reason_code ?? "manual_approval",
    });
    const updated = db.prepare("SELECT * FROM payments WHERE id = ?").get(id);
    reply.send(paymentView(updated as Record<string, unknown>));
  });

  app.post("/v1/approvals/:id/reject", { preHandler: requireScope("approvals:write") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { reason_code?: string };
    const p = db.prepare("SELECT * FROM payments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!p) {
      reply.code(404).send({ error: "payment not found" });
      return;
    }
    if (p.status !== "pending_approval") {
      reply.code(409).send({ error: `payment is ${p.status}, not pending_approval` });
      return;
    }
    db.prepare("UPDATE payments SET status='rejected', decided_at=?, decided_by=?, reason_code=? WHERE id = ?").run(
      now(),
      req.apiKey.name,
      body.reason_code ?? "manual_rejection",
      id
    );
    audit(db, req.apiKey.name, "payment.rejected", "payment", id, { reason_code: body.reason_code ?? "manual_rejection" });
    emit(db, "payment.rejected", { payment_id: id, reason_code: body.reason_code ?? "manual_rejection" });
    const updated = db.prepare("SELECT * FROM payments WHERE id = ?").get(id);
    reply.send(paymentView(updated as Record<string, unknown>));
  });
}
