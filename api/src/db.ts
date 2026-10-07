import { DatabaseSync } from "node:sqlite";

// SQLite via node:sqlite. One file, WAL mode, foreign keys on.
// All money movement goes through ledger_entries as double-entry rows
// inside a single transaction: every payment writes a debit and a credit
// whose amounts sum to zero, so conservation is structural.

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      per_tx_cap INTEGER NOT NULL DEFAULT 100000,
      daily_cap INTEGER NOT NULL DEFAULT 1000000,
      weekly_cap INTEGER NOT NULL DEFAULT 5000000,
      solana_pubkey TEXT,
      evm_address TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      from_wallet TEXT NOT NULL REFERENCES wallets(id),
      to_wallet TEXT NOT NULL REFERENCES wallets(id),
      amount INTEGER NOT NULL,
      memo TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      decided_by TEXT,
      reason_code TEXT
    );
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id TEXT NOT NULL REFERENCES wallets(id),
      payment_id TEXT NOT NULL REFERENCES payments(id),
      direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
      amount INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_wallet ON ledger_entries(wallet_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_payment ON ledger_entries(payment_id);
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
    CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id),
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS settlements (
      id TEXT PRIMARY KEY,
      payment_id TEXT NOT NULL REFERENCES payments(id),
      rail TEXT NOT NULL,
      status TEXT NOT NULL,
      tx_hash TEXT,
      details TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

export function now(): number {
  return Date.now();
}

/** Run fn inside an IMMEDIATE transaction; rolls back on throw. */
export function withTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already rolled back
    }
    throw err;
  }
}

export function balanceOf(db: DatabaseSync, walletId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount ELSE -amount END), 0) AS b
       FROM ledger_entries WHERE wallet_id = ?`
    )
    .get(walletId) as { b: number };
  return row.b;
}

/** Sum of completed outbound payments in the last `windowMs`. */
export function spendSince(db: DatabaseSync, walletId: string, windowMs: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(p.amount), 0) AS s FROM payments p
       JOIN ledger_entries l ON l.payment_id = p.id AND l.direction = 'debit' AND l.wallet_id = ?
       WHERE p.status = 'completed' AND p.created_at >= ?`
    )
    .get(walletId, now() - windowMs) as { s: number };
  return row.s;
}
