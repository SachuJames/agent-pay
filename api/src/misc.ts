import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { requireScope, createApiKey, type Scope } from "./auth.js";
import { audit } from "./audit.js";
import { createEndpoint } from "./webhooks.js";

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

  app.get("/v1/webhook-deliveries", { preHandler: requireScope("read") }, async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
    const rows = db.prepare("SELECT * FROM webhook_deliveries ORDER BY id DESC LIMIT ?").all(limit);
    return { deliveries: rows };
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
