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

  // Rotate a key: mint a replacement with the same name and scopes, then
  // revoke the old one. The raw replacement is returned once, like creation.
  // Callers swap their stored key and the old one stops working immediately,
  // so a leaked key can be replaced without a permissions gap in between.
  app.post("/v1/api-keys/:id/rotate", { preHandler: requireScope("admin") }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = db.prepare("SELECT id, name, scopes, revoked_at FROM api_keys WHERE id = ?").get(id) as
      | { id: string; name: string; scopes: string; revoked_at: number | null }
      | undefined;
    if (!row) {
      reply.code(404).send({ error: "api key not found" });
      return;
    }
    if (row.revoked_at !== null) {
      reply.code(409).send({ error: "cannot rotate a revoked key" });
      return;
    }
    const scopes = JSON.parse(row.scopes) as Scope[];
    const { id: newId, raw } = createApiKey(db, row.name, scopes);
    db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(Date.now(), id);
    audit(db, req.apiKey.name, "apikey.rotated", "api_key", id, { name: row.name, new_key_id: newId });
    reply.code(201).send({ id: newId, key: raw, name: row.name, scopes, rotated_from: id });
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

  // Pause or resume a subscription. While paused, queued deliveries wait
  // and new events are skipped; resuming lets the drain pick up the queue.
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
    const q = req.query as { limit?: string; endpoint_id?: string; status?: string };
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
    const conds: string[] = [];
    const vals: (string | number | null)[] = [];
    if (q.endpoint_id) {
      conds.push("endpoint_id = ?");
      vals.push(q.endpoint_id);
    }
    if (q.status) {
      conds.push("status = ?");
      vals.push(q.status);
    }
    const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
    const rows = db.prepare(`SELECT * FROM webhook_deliveries ${where} ORDER BY id DESC LIMIT ?`).all(...vals, limit);
    return { deliveries: rows };
  });

  // Requeue a delivery that parked as failed after its retries ran out.
  // Attempts reset, so the endpoint gets a fresh set of tries; useful when
  // the receiver was down and is back, without replaying the whole event
  // stream by hand.
  app.post("/v1/webhook-deliveries/:id/retry", { preHandler: requireScope("admin") }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const row = db.prepare("SELECT id, status FROM webhook_deliveries WHERE id = ?").get(id) as
      | { id: number; status: string }
      | undefined;
    if (!row) {
      reply.code(404).send({ error: "delivery not found" });
      return;
    }
    if (row.status !== "failed") {
      reply.code(409).send({ error: `only failed deliveries can be retried (this one is ${row.status})` });
      return;
    }
    db.prepare("UPDATE webhook_deliveries SET status='queued', attempts=0, next_attempt_at=?, last_error=NULL WHERE id = ?").run(
      Date.now(),
      id
    );
    audit(db, req.apiKey.name, "webhook.delivery_retried", "webhook_delivery", String(id), {});
    const updated = db.prepare("SELECT * FROM webhook_deliveries WHERE id = ?").get(id);
    reply.send(updated);
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
