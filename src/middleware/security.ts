import type { RequestHandler } from "express";

type RateLimitOpts = { windowMs: number; max: number };

// Lets the API docs detect rate-limited routes and document the 429 automatically.
const rateLimitInfo = new WeakMap<RequestHandler, RateLimitOpts>();
export const getRateLimitInfo = (h: RequestHandler) => rateLimitInfo.get(h);

export function rateLimit(opts: RateLimitOpts): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const handler: RequestHandler = (req, res, next) => {
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
      res
        .status(429)
        .json({
          error: {
            code: "rate_limited",
            message: "Too many requests, slow down",
          },
        });
      return;
    }
    next();
  };
  rateLimitInfo.set(handler, opts);
  return handler;
}

/** Prevent API responses (which may contain code/doc snippets) from being cached by browsers/proxies. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};
