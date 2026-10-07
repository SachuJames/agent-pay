import Fastify from "fastify";
import { openDb } from "./db.js";
import { registerAuth, createApiKey } from "./auth.js";
import { registerRateLimit } from "./ratelimit.js";
import { registerWalletRoutes, ensureTreasury } from "./wallets.js";
import { registerPaymentRoutes } from "./payments.js";
import { registerApprovalRoutes } from "./approvals.js";
import { registerSettlementRoutes } from "./settle.js";
import { registerMiscRoutes } from "./misc.js";
import { drainWebhooks } from "./webhooks.js";

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.DB_PATH ?? "./agentpay.db";

export async function buildApp(dbPath = DB_PATH) {
  const db = openDb(dbPath);
  ensureTreasury(db);

  const app = Fastify({ logger: false });
  registerAuth(app, db);
  registerRateLimit(app, {
    max: Number(process.env.RATE_LIMIT_MAX ?? 300),
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
  });
  registerWalletRoutes(app, db);
  registerPaymentRoutes(app, db);
  registerApprovalRoutes(app, db);
  registerSettlementRoutes(app, db);
  registerMiscRoutes(app, db);

  // Background webhook delivery.
  const timer = setInterval(() => {
    drainWebhooks(db).catch(() => {});
  }, 2000);
  timer.unref();

  return { app, db };
}

async function main() {
  const { app, db } = await buildApp();

  // Bootstrap a master key on first run so there is always a way in.
  // The raw key is printed once; store it somewhere safe.
  const existing = db.prepare("SELECT id FROM api_keys LIMIT 1").get();
  if (!existing) {
    const { raw } = createApiKey(db, "master", ["admin"]);
    console.log(`MASTER_API_KEY=${raw}`);
  }

  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`agentpay api listening on :${PORT} (db: ${DB_PATH})`);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
