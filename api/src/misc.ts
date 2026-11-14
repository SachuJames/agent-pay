import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { requireScope, createApiKey, type Scope } from "./auth.js";
import { audit } from "./audit.js";
import { createEndpoint } from "./webhooks.js";
import { withTx } from "./db.js";

export function registerMiscRoutes(app: FastifyInstance, db: DatabaseSync) {
  app.get("/health", async () => ({ ok: true, service: "agentpay-api" }));

  // API key management (admin scope).
  app.post("/v1/api-keys", { preHandler: requireScope("admin") }, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; scopes?: Scope[] };
    if (!body.name || !Array.isArray(body.scopes) || body.scopes.length === 0) {
      reply.code(400).send({ error: "name and non-empty scopes array are required" });
      return;
    }
    try {
      const { id, raw } = createApiKey(db, body.name, body.scopes);
      audit(db, req.apiKey.name, "apikey.created", "api_key", id, { name: body.name, scopes: body.scopes });
      reply.code(201).send({ id, key: raw, name: body.name, scopes: body.scopes });
    } catch (err) {
      reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  app.get("/v1/api-keys", { preHandler: requireScope("admin") }, async () => {
    const rows = db
      .prepare("SELECT id, name, scopes, created_at, revoked_at, last_used_at FROM api_keys ORDER BY created_at DESC")
      .all() as { id: string; name: string; scopes: string; created_at: number; revoked_at: number | null; last_used_at: number | null }[];
    return {
      api_keys: rows.map((r) => ({
        id: r.id,
        name: r.name,
        scopes: JSON.parse(r.scopes),
        created_at: r.created_at,
        revoked_at: r.revoked_at,
        last_used_at: r.last_used_at,
      })),
    };
  });

  app.post("/v1/api-keys/:id/revoke", { preHandler: requireScope("admin") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = db.prepare("SELECT id FROM api_keys WHERE id = ?").get(id);
    if (!row) {
      reply.code(404).send({ error: "api key not found" });
      return;
    }
    db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(Date.now(), id);
    audit(db, req.apiKey.name, "apikey.revoked", "api_key", id, {});
    reply.send({ id, revoked: true });
  });

  // Webhook subscriptions.
  app.post("/v1/webhooks", { preHandler: requireScope("admin") }, async (req, reply) => {
    const body = (req.body ?? {}) as { url?: string; events?: string[] };
    if (!body.url || !Array.isArray(body.events) || body.events.length === 0) {
      reply.code(400).send({ error: "url and non-empty events array are required" });
      return;
    }
    try {
      const { id, secret } = createEndpoint(db, body.url, body.events);
      audit(db, req.apiKey.name, "webhook.created", "webhook", id, { url: body.url, events: body.events });
      reply.code(201).send({ id, url: body.url, events: body.events, secret });
    } catch (err) {
      reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  app.get("/v1/webhooks", { preHandler: requireScope("read") }, async () => {
    const rows = db.prepare("SELECT id, url, events, active, created_at FROM webhook_endpoints ORDER BY created_at DESC").all();
    return { webhooks: rows };
  });

  // Pause or resume a subscription. Pausing stops new deliveries and holds
  // queued ones in place; resuming lets the drain pick them up again.
  app.patch("/v1/webhooks/:id", { preHandler: requireScope("admin") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { active?: boolean };
    const row = db.prepare("SELECT * FROM webhook_endpoints WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) {
      reply.code(404).send({ error: "webhook not found" });
      return;
    }
    if (typeof body.active !== "boolean") {
      reply.code(400).send({ error: "active (boolean) is required" });
      return;
    }
    db.prepare("UPDATE webhook_endpoints SET active = ? WHERE id = ?").run(body.active ? 1 : 0, id);
    audit(db, req.apiKey.name, "webhook.updated", "webhook", id, { active: body.active });
    const updated = db.prepare("SELECT id, url, events, active, created_at FROM webhook_endpoints WHERE id = ?").get(id);
    reply.send(updated);
  });

  app.delete("/v1/webhooks/:id", { preHandler: requireScope("admin") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = db.prepare("SELECT id FROM webhook_endpoints WHERE id = ?").get(id);
    if (!row) {
      reply.code(404).send({ error: "webhook not found" });
      return;
    }
    withTx(db, () => {
      db.prepare("DELETE FROM webhook_deliveries WHERE endpoint_id = ?").run(id);
      db.prepare("DELETE FROM webhook_endpoints WHERE id = ?").run(id);
    });
    audit(db, req.apiKey.name, "webhook.deleted", "webhook", id, {});
    reply.send({ id, deleted: true });
  });

  app.get("/v1/webhook-deliveries", { preHandler: requireScope("read") }, async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
    const rows = db.prepare("SELECT * FROM webhook_deliveries ORDER BY id DESC LIMIT ?").all(limit);
    return { deliveries: rows };
  });

  // Operational summary for dashboards and alerting: counts and volume,
  // computed straight from the tables, no separate stats store to drift.
  app.get("/v1/metrics", { preHandler: requireScope("admin") }, async () => {
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const byStatus = db.prepare("SELECT status, COUNT(*) AS n FROM payments GROUP BY status").all() as {
      status: string;
      n: number;
    }[];
    const deliveries = db.prepare("SELECT status, COUNT(*) AS n FROM webhook_deliveries GROUP BY status").all() as {
      status: string;
      n: number;
    }[];
    const toMap = (rows: { status: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.status, r.n]));
    return {
      wallets: count("SELECT COUNT(*) AS n FROM wallets"),
      payments: {
        total: count("SELECT COUNT(*) AS n FROM payments"),
        by_status: toMap(byStatus),
        completed_volume_minor: count(
          "SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE status = 'completed' AND refund_of IS NULL"
        ),
      },
      webhook_endpoints_active: count("SELECT COUNT(*) AS n FROM webhook_endpoints WHERE active = 1"),
      webhook_deliveries: toMap(deliveries),
      api_keys: {
        active: count("SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL"),
        revoked: count("SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NOT NULL"),
      },
    };
  });

  // Audit log (read-only; append-only by design).
  app.get("/v1/audit", { preHandler: requireScope("read") }, async (req) => {
    const q = req.query as { entity?: string; entity_id?: string; limit?: string };
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
    const conds: string[] = [];
    const vals: (string | number | null)[] = [];
    if (q.entity) {
      conds.push("entity = ?");
      vals.push(q.entity);
    }
    if (q.entity_id) {
      conds.push("entity_id = ?");
      vals.push(q.entity_id);
    }
    const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
    const rows = db.prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`).all(...vals, limit);
    return { audit: rows };
  });
}
