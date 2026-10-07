import type { DatabaseSync } from "node:sqlite";
import { now } from "./db.js";

// Append-only audit log. There is intentionally no update or delete path:
// every state change in the system writes one row here.

export function audit(
  db: DatabaseSync,
  actor: string,
  action: string,
  entity: string,
  entityId: string,
  details: Record<string, unknown> = {}
): void {
  db.prepare("INSERT INTO audit_log (actor, action, entity, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    actor,
    action,
    entity,
    entityId,
    JSON.stringify(details),
    now()
  );
}
