import type { RequestHandler } from "express";

/**
 * Very small fixed-window rate limiter per client IP (in memory).
 * Protects the Azure OpenAI quota from accidental floods. For multiple instances,
 * use a shared store (e.g. Redis) or an API gateway instead.
 */
export function rateLimit(opts: { windowMs: number; max: number }): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      }
      return next();
    }
    entry.count++;
    if (entry.count > opts.max) {
      res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
      res.status(429).json({ error: { code: "rate_limited", message: "Too many requests, slow down" } });
      return;
    }
    next();
  };
}

/** Prevent API responses (which may contain code/doc snippets) from being cached by browsers/proxies. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};
