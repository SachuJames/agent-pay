import { createHmac, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { now } from "./db.js";

// Signed webhook delivery. Each event is POSTed to subscribed endpoints
// with an HMAC-SHA256 signature over the raw body in the
// `X-AgentPay-Signature` header (hex, `sha256=` prefix). Failed deliveries
// retry with exponential backoff up to 5 attempts, then park as failed.

export const SIGNATURE_HEADER = "x-agentpay-signature";

export function signPayload(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export function verifySignature(secret: string, body: string, sig: string): boolean {
  const expected = signPayload(secret, body);
  if (sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function emit(db: DatabaseSync, event: string, payload: Record<string, unknown>): void {
  const eps = db
    .prepare("SELECT id, events FROM webhook_endpoints WHERE active = 1")
    .all() as { id: string; events: string }[];
  const body = JSON.stringify({ event, ...payload, emitted_at: now() });
  for (const ep of eps) {
    const events: string[] = JSON.parse(ep.events);
    if (!events.includes(event) && !events.includes("*")) continue;
    db.prepare(
      "INSERT INTO webhook_deliveries (endpoint_id, event, payload, status, attempts, next_attempt_at) VALUES (?, ?, ?, 'queued', 0, ?)"
    ).run(ep.id, event, body, now());
  }
}

async function deliverOnce(db: DatabaseSync, id: number): Promise<void> {
  const d = db
    .prepare(
      `SELECT d.*, e.url, e.secret FROM webhook_deliveries d
       JOIN webhook_endpoints e ON e.id = d.endpoint_id WHERE d.id = ?`
    )
    .get(id) as {
    id: number;
    endpoint_id: string;
    event: string;
    payload: string;
    attempts: number;
    url: string;
    secret: string;
  };
  const sig = signPayload(d.secret, d.payload);
  try {
    const res = await fetch(d.url, {
      method: "POST",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: sig },
      body: d.payload,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    db.prepare("UPDATE webhook_deliveries SET status='delivered', attempts=attempts+1, last_error=NULL WHERE id = ?").run(id);
  } catch (err) {
    const attempts = d.attempts + 1;
    if (attempts >= 5) {
      db.prepare("UPDATE webhook_deliveries SET status='failed', attempts=?, last_error=? WHERE id = ?").run(
        attempts,
        String(err),
        id
      );
    } else {
      const backoff = 2 ** attempts * 1000;
      db.prepare("UPDATE webhook_deliveries SET status='queued', attempts=?, next_attempt_at=?, last_error=? WHERE id = ?").run(
        attempts,
        now() + backoff,
        String(err),
        id
      );
    }
  }
}

/** Drain due deliveries. Called on a timer and directly in tests. */
export async function drainWebhooks(db: DatabaseSync): Promise<number> {
  const due = db
    .prepare("SELECT id FROM webhook_deliveries WHERE status='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)")
    .all(now()) as { id: number }[];
  for (const d of due) await deliverOnce(db, d.id);
  return due.length;
}

export function createEndpoint(
  db: DatabaseSync,
  url: string,
  events: string[]
): { id: string; secret: string } {
  if (!/^https?:\/\//.test(url)) throw new Error("webhook url must be http(s)");
  const id = randomUUID();
  const secret = "whsec_" + randomUUID().replace(/-/g, "");
  db.prepare("INSERT INTO webhook_endpoints (id, url, secret, events, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    url,
    secret,
    JSON.stringify(events),
    now()
  );
  return { id, secret };
}
