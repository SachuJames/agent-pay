import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { now } from "./db.js";

export const SCOPES = ["read", "wallets:write", "payments:write", "approvals:write", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function mintKey(): { raw: string; hash: string } {
  const raw = "agp_" + randomBytes(24).toString("hex");
  return { raw, hash: hashKey(raw) };
}

export interface KeyRecord {
  id: string;
  name: string;
  scopes: Scope[];
}

declare module "fastify" {
  interface FastifyRequest {
    apiKey: KeyRecord;
  }
}

function parseBearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  return h.slice(7).trim() || null;
}

export function registerAuth(app: FastifyInstance, db: DatabaseSync) {
  app.decorateRequest("apiKey", null as unknown as KeyRecord);

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return;
    const raw = parseBearer(req);
    if (!raw) {
      reply.code(401).send({ error: "missing bearer api key" });
      return;
    }
    const row = db
      .prepare("SELECT id, name, scopes, revoked_at FROM api_keys WHERE key_hash = ?")
      .get(hashKey(raw)) as { id: string; name: string; scopes: string; revoked_at: number | null } | undefined;
    if (!row || row.revoked_at !== null) {
      reply.code(401).send({ error: "invalid or revoked api key" });
      return;
    }
    req.apiKey = { id: row.id, name: row.name, scopes: JSON.parse(row.scopes) as Scope[] };
  });
}

export function requireScope(...scopes: Scope[]) {
  return async (req: FastifyRequest, reply: import("fastify").FastifyReply) => {
    const has = req.apiKey.scopes.includes("admin") || scopes.some((s) => req.apiKey.scopes.includes(s));
    if (!has) {
      reply.code(403).send({ error: "insufficient scope", required: scopes });
    }
  };
}

export function createApiKey(db: DatabaseSync, name: string, scopes: Scope[]): { id: string; raw: string } {
  for (const s of scopes) {
    if (!SCOPES.includes(s)) throw new Error(`unknown scope: ${s}`);
  }
  const { raw, hash } = mintKey();
  const id = randomUUID();
  db.prepare("INSERT INTO api_keys (id, name, key_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    name,
    hash,
    JSON.stringify(scopes),
    now()
  );
  return { id, raw };
}
