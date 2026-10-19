import type { FastifyRequest } from 'fastify';

/**
 * Small in-memory rate limiter (fixed window per key). One API process, so memory is enough;
 * counters reset if the API restarts, which only makes limits briefly looser.
 */
interface Window {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Window>();

export interface LimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

export function hit(key: string, max: number, windowMs: number): LimitResult {
  const now = Date.now();
  let w = buckets.get(key);
  if (!w || w.resetAt <= now) {
    w = { count: 0, resetAt: now + windowMs };
    buckets.set(key, w);
  }
  w.count++;
  return {
    ok: w.count <= max,
    remaining: Math.max(0, max - w.count),
    retryAfterSec: Math.ceil((w.resetAt - now) / 1000),
  };
}

// Drop expired windows now and then so the map does not grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [k, w] of buckets) if (w.resetAt <= now) buckets.delete(k);
}, 60_000).unref();

/**
 * The visitor's IP. The API only listens on 127.0.0.1, so every request comes through the
 * Next.js site, which appends the address it saw to X-Forwarded-For. Use the LAST entry: a
 * visitor can put anything in the header they send, but not in what the site appends after it.
 * Behind Cloudflare, CF-Connecting-IP is set by Cloudflare itself and is preferred.
 */
const TRUST_CF = process.env.TRUST_CLOUDFLARE === '1';

export function clientIp(req: FastifyRequest): string {
  // Only trusted when the site is published through Cloudflare (TRUST_CLOUDFLARE=1); otherwise
  // anyone could send this header themselves to dodge the limits.
  const cf = req.headers['cf-connecting-ip'];
  if (TRUST_CF && typeof cf === 'string' && cf) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return chain[chain.length - 1] ?? req.ip;
}
