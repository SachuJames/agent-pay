import type { FastifyInstance } from "fastify";

// In-memory token bucket per API key. Simple, no external store needed at
// this scale; buckets reset on restart which is acceptable for a demo-grade
// limiter (documented in ARCHITECTURE.md).

interface Bucket {
  tokens: number;
  last: number;
}

const buckets = new Map<string, Bucket>();

export interface LimiterOptions {
  /** max requests per window */
  max: number;
  /** window in ms */
  windowMs: number;
}

export function registerRateLimit(app: FastifyInstance, opts: LimiterOptions) {
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return;
    const key = (req.apiKey && req.apiKey.id) || req.ip;
    const t = Date.now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: opts.max, last: t };
      buckets.set(key, b);
    }
    const elapsed = t - b.last;
    b.tokens = Math.min(opts.max, b.tokens + (elapsed / opts.windowMs) * opts.max);
    b.last = t;
    if (b.tokens < 1) {
      reply.code(429).send({ error: "rate limit exceeded" });
      return;
    }
    b.tokens -= 1;
  });
}

/** For tests. */
export function resetBuckets() {
  buckets.clear();
}
