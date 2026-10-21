import Fastify from 'fastify';
import { db } from './db.js';
import { ensurePincode, getPincode, isValidPincode } from './pincodes.js';
import {
  latestPrices,
  pincodeOverview,
  platformListings,
  platformName,
  platformStatus,
  priceHistory,
  setDetail,
} from './queries.js';
import { adapters } from './adapters/index.js';
import { getJob, latestJob, REFRESH_COOLDOWN_MS, requestRefresh } from './jobs.js';
import { thumbnail } from './images.js';
import { clientIp, hit } from './limits.js';

// Local only: there is no auth on this API. The Next.js site (web/) proxies /api/* to it.
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4100);

const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 4096 });

/** Most pincodes the site will track at once. New ones beyond this are refused. */
const MAX_PINCODES = Number(process.env.MAX_PINCODES ?? 40);

function limited(reply: any, retryAfterSec: number, what: string) {
  return reply
    .code(429)
    .header('retry-after', String(retryAfterSec))
    .send({ error: `Too many ${what}. Try again in ${Math.max(1, Math.ceil(retryAfterSec / 60))} min.` });
}

// Every request: a generous per-visitor ceiling so one client can not flood the API.
// A page view loads about 50 set photos, and many mobile users share one address (carrier NAT), so
// photos get their own, larger allowance; everything else keeps the tighter one.
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
  const photo = req.url.startsWith('/api/img/');
  const r = hit(`${photo ? 'img' : 'all'}:${clientIp(req)}`, photo ? 6000 : 600, 60_000);
  if (!r.ok) return limited(reply, r.retryAfterSec, 'requests');
});

// The catalogue response is the same for everyone at a pincode; keep it for a few seconds so
// a crowd of visitors costs one database read, not one each.
const overviewCache = new Map<string, { at: number; body: unknown }>();
const OVERVIEW_TTL_MS = 15_000;
const markViewed = db.prepare(
  "UPDATE pincodes SET last_viewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE pincode = ? AND (last_viewed_at IS NULL OR last_viewed_at < ?)",
);

app.get('/health', async () => ({ ok: true }));

app.get('/api/pincodes', async () => db.prepare('SELECT pincode, city FROM pincodes ORDER BY pincode').all());

// Start tracking any Indian pincode. The worker picks it up on its next run.
app.post<{ Body: { pincode?: string } }>('/api/pincodes', async (req, reply) => {
  const pin = req.body?.pincode;
  if (!pin || !isValidPincode(pin)) return reply.code(400).send({ error: 'Enter a valid 6 digit pincode.' });
  const known = getPincode(pin);
  if (!known) {
    // Each new pincode adds crawls of every store, so adding them is limited per visitor and overall.
    const r = hit(`pin:${clientIp(req)}`, 5, 3600_000);
    if (!r.ok) return limited(reply, r.retryAfterSec, 'new pincodes');
    const count = (db.prepare('SELECT COUNT(*) AS n FROM pincodes').get() as { n: number }).n;
    if (count >= MAX_PINCODES) {
      return reply.code(503).send({ error: 'We are tracking as many pincodes as we can right now. Please try a nearby tracked pincode.' });
    }
  }
  try {
    const { pincode, city } = await ensurePincode(pin);
    return { pincode, city };
  } catch (e) {
    return reply.code(422).send({ error: (e as Error).message });
  }
});

// The catalogue view: every LEGO set listed at a pincode, with each platform's latest price.
app.get<{ Querystring: { pincode?: string } }>('/api/sets', async (req, reply) => {
  const { pincode } = req.query;
  if (!pincode) return reply.code(400).send({ error: 'pincode is required' });
  // Shared caches (Cloudflare, when a cache rule allows it) may keep this for 15 seconds too.
  reply.header('cache-control', 'public, max-age=0, s-maxage=15');
  const cached = overviewCache.get(pincode);
  if (cached && Date.now() - cached.at < OVERVIEW_TTL_MS) return cached.body;
  const overview = pincodeOverview(pincode);
  if (!overview) return reply.code(404).send({ error: 'That pincode is not being tracked yet.' });
  overviewCache.set(pincode, { at: Date.now(), body: overview });
  // Keeps the pincode in the scheduled crawls (written at most once an hour per pincode).
  markViewed.run(pincode, new Date(Date.now() - 3600_000).toISOString());
  return overview;
});

// One set: catalog info, every store's latest offer, and its price changes at a pincode.
app.get<{ Params: { setNumber: string }; Querystring: { pincode?: string } }>(
  '/api/set/:setNumber',
  async (req, reply) => {
    const { pincode } = req.query;
    if (!pincode) return reply.code(400).send({ error: 'pincode is required' });
    if (!/^\d{3,7}$/.test(req.params.setNumber)) return reply.code(400).send({ error: 'invalid set number' });
    const detail = setDetail(req.params.setNumber, pincode);
    if (!detail) return reply.code(404).send({ error: 'Unknown set number.' });
    return detail;
  },
);

// Small WebP thumbnails of set photos, cached on disk (see images.ts). ?w= picks the size.
app.get<{ Params: { setNumber: string }; Querystring: { w?: string } }>('/api/img/:setNumber', async (req, reply) => {
  if (!/^\d{3,7}$/.test(req.params.setNumber)) return reply.code(400).send({ error: 'invalid set number' });
  try {
    const buf = await thumbnail(req.params.setNumber, Number(req.query.w) || 320);
    return reply
      .header('content-type', 'image/webp')
      .header('cache-control', 'public, max-age=2592000, immutable')
      .send(buf);
  } catch {
    return reply.code(404).send({ error: 'no image' });
  }
});

// Every platform's latest price for one set at one pincode.
app.get<{ Querystring: { set?: string; pincode?: string } }>('/api/prices', async (req, reply) => {
  const { set, pincode } = req.query;
  if (!set || !pincode) return reply.code(400).send({ error: 'set and pincode are required' });
  return latestPrices(set, pincode);
});

app.get<{ Querystring: { set?: string; pincode?: string } }>('/api/history', async (req, reply) => {
  const { set, pincode } = req.query;
  if (!set || !pincode) return reply.code(400).send({ error: 'set and pincode are required' });
  return priceHistory(set, pincode);
});

// "Fetch live rates": queue a refresh of every store for a pincode. The worker runs it.
app.post<{ Body: { pincode?: string } }>('/api/refresh', async (req, reply) => {
  const pin = req.body?.pincode;
  if (!pin || !isValidPincode(pin)) return reply.code(400).send({ error: 'Enter a valid 6 digit pincode.' });
  // Refreshes only for pincodes already tracked (adding one goes through /api/pincodes and its limits).
  if (!getPincode(pin)) return reply.code(404).send({ error: 'That pincode is not being tracked yet.' });
  // Per visitor: a few refreshes per 10 minutes. Per pincode there is also a cooldown (jobs.ts),
  // and the worker runs one refresh at a time, so the stores never see more than one at once.
  const r = hit(`refresh:${clientIp(req)}`, 4, 10 * 60_000);
  if (!r.ok) return limited(reply, r.retryAfterSec, 'refreshes');
  const waiting = (db.prepare("SELECT COUNT(*) AS n FROM refresh_jobs WHERE status IN ('queued','running')").get() as { n: number }).n;
  if (waiting >= 5 && !(db.prepare("SELECT 1 FROM refresh_jobs WHERE pincode = ? AND status IN ('queued','running')").get(pin))) {
    return reply.code(503).send({ error: 'Lots of refreshes are running right now. Prices update on their own every few minutes.' });
  }
  const { job, created } = requestRefresh(pin);
  return reply.code(created ? 202 : 200).send({ job, created, cooldownMs: REFRESH_COOLDOWN_MS });
});

app.get<{ Params: { id: string } }>('/api/refresh/:id', async (req, reply) => {
  const job = getJob(Number(req.params.id));
  if (!job) return reply.code(404).send({ error: 'No such refresh.' });
  return { job };
});

app.get<{ Querystring: { pincode?: string } }>('/api/refresh', async (req, reply) => {
  const { pincode } = req.query;
  if (!pincode) return reply.code(400).send({ error: 'pincode is required' });
  return { job: latestJob(pincode) };
});

// Per platform health at a pincode: listing counts, last crawl, whether it delivers there.
app.get<{ Querystring: { pincode?: string } }>('/api/status', async (req, reply) => {
  const { pincode } = req.query;
  if (!pincode) return reply.code(400).send({ error: 'pincode is required' });
  return { pincode, platforms: platformStatus(adapters.map((a) => a.id), pincode) };
});

// One route per platform: /api/blinkit, /api/amazon, /api/flipkart, ...
// Each returns that platform's latest LEGO prices at a pincode, served from the database
// the worker keeps fresh (no live scrape per request, so it answers instantly).
for (const a of adapters) {
  app.get<{ Querystring: { pincode?: string } }>(`/api/${a.id}`, async (req, reply) => {
    const { pincode } = req.query;
    if (!pincode) return reply.code(400).send({ error: 'pincode is required' });
    const listings = platformListings(a.id, pincode);
    const lastChecked = listings.reduce<string | null>((m, l: any) => (!m || l.checkedAt > m ? l.checkedAt : m), null);
    return { platform: a.id, name: platformName(a.id), pincode, lastChecked, count: listings.length, listings };
  });
}

await app.listen({ host: HOST, port: PORT });
