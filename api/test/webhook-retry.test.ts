import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/index.js";
import { createApiKey } from "../src/auth.js";
import { resetBuckets } from "../src/ratelimit.js";
import { drainWebhooks } from "../src/webhooks.js";
import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";

let app: FastifyInstance;
let db: DatabaseSync;
let key: string;

beforeEach(async () => {
  resetBuckets();
  const built = await buildApp(":memory:");
  app = built.app;
  db = built.db;
  await app.ready();
  key = createApiKey(db, "test", ["admin"]).raw;
});

afterEach(async () => {
  await app.close();
});

function auth() {
  return { authorization: `Bearer ${key}` };
}

async function postJson(url: string, body: unknown = {}) {
  const res = await app.inject({
    method: "POST",
    url,
    headers: { ...auth(), "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

/** Subscribe to a receiver that fails until told otherwise, then park a delivery as failed. */
async function failedDelivery() {
  let healthy = false;
  const received: string[] = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (healthy) {
        received.push(data);
        res.writeHead(200).end("ok");
      } else {
        res.writeHead(500).end("boom");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  const sub = await postJson("/v1/webhooks", { url: `http://127.0.0.1:${port}/hook`, events: ["wallet.created"] });
  await postJson("/v1/wallets", { agent_id: "a1", name: "w1" });

  await drainWebhooks(db); // first attempt fails, backoff queued
  // skip the remaining backoff waits by fast-forwarding the row
  db.prepare("UPDATE webhook_deliveries SET attempts = 4, next_attempt_at = 0").run();
  await drainWebhooks(db); // fifth attempt fails, parks as failed

  const row = db.prepare("SELECT * FROM webhook_deliveries").get() as { id: number; status: string; attempts: number };
  expect(row.status).toBe("failed");
  expect(row.attempts).toBe(5);
  return { server, received, deliveryId: row.id, endpointId: sub.body.id as string, heal: () => (healthy = true) };
}

describe("webhook delivery retry", () => {
  it("requeues a failed delivery and it lands once the receiver is back", async () => {
    const { server, received, deliveryId, heal } = await failedDelivery();
    heal();
    const retried = await postJson(`/v1/webhook-deliveries/${deliveryId}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body.status).toBe("queued");
    expect(retried.body.attempts).toBe(0);
    expect(retried.body.last_error).toBeNull();

    await drainWebhooks(db);
    expect(received.length).toBe(1);
    const row = db.prepare("SELECT status FROM webhook_deliveries WHERE id = ?").get(deliveryId) as { status: string };
    expect(row.status).toBe("delivered");

    // and now it cannot be retried again
    expect((await postJson(`/v1/webhook-deliveries/${deliveryId}/retry`)).status).toBe(409);
    server.close();
  });

  it("404s an unknown delivery", async () => {
    expect((await postJson("/v1/webhook-deliveries/9999/retry")).status).toBe(404);
  });

  it("filters the delivery list by endpoint and status", async () => {
    const { server, endpointId } = await failedDelivery();
    const byStatus = await app.inject({ method: "GET", url: "/v1/webhook-deliveries?status=failed", headers: auth() });
    const failed = byStatus.json().deliveries as { endpoint_id: string }[];
    expect(failed.length).toBe(1);
    expect(failed[0].endpoint_id).toBe(endpointId);

    const byEndpoint = await app.inject({
      method: "GET",
      url: `/v1/webhook-deliveries?endpoint_id=${endpointId}&status=queued`,
      headers: auth(),
    });
    expect(byEndpoint.json().deliveries).toHaveLength(0);
    server.close();
  });
});
