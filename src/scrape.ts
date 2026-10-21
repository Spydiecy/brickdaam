import { db } from './db.js';
import { adapters } from './adapters/index.js';
import { cleanTitle, createNameMatcher, isBundle, isLego, matchByNumber } from './match.js';
import { closeBrowser } from './browser.js';
import { candidatePoints } from './geo.js';
import { NotServiceableError, type Adapter, type Pincode, type RawListing } from './types.js';

// How many (platform, pincode) crawls run at the same time.
const CONCURRENCY = Math.max(1, Number(process.env.SCRAPE_CONCURRENCY ?? 2));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Consecutive failures per "platform:pincode" and the time before which scheduled runs skip it.
// Kept in memory: a worker restart gives every store a fresh start, which is fine.
const failStreak = new Map<string, number>();
const coolDownUntil = new Map<string, number>();
const REST_MINUTES = [30, 60, 120, 240]; // after the 1st, 2nd, 3rd, 4th+ failure in a row

/** Remember how a crawl ended (any crawl, scheduled or live) so scheduled runs can rest failing stores. */
function noteOutcome(platform: string, pincode: string, ok: boolean): void {
  const key = `${platform}:${pincode}`;
  if (ok) {
    failStreak.delete(key);
    coolDownUntil.delete(key);
    return;
  }
  const n = (failStreak.get(key) ?? 0) + 1;
  failStreak.set(key, n);
  coolDownUntil.set(key, Date.now() + REST_MINUTES[Math.min(n, REST_MINUTES.length) - 1] * 60_000);
}
const liveRunning = db.prepare("SELECT 1 FROM refresh_jobs WHERE pincode = ? AND status = 'running'");
/** Scheduled crawls cover pincodes viewed within this many days. */
const ACTIVE_DAYS = Number(process.env.ACTIVE_DAYS ?? 7);
const TRANSIENT = /timeout|timed out|failed to fetch|net::ERR_|ECONNRESET|ETIMEDOUT|socket hang up|Target (page|closed)/i;

const upsertListing = db.prepare(`
  INSERT INTO listings (set_number, platform, platform_product_id, title, url, brand)
  VALUES (@setNumber, @platform, @productId, @title, @url, @brand)
  ON CONFLICT(platform, platform_product_id) DO UPDATE SET
    set_number = excluded.set_number, title = excluded.title, url = excluded.url, brand = excluded.brand
  RETURNING id`);

const latestRow = db.prepare(`
  SELECT id, price, mrp, in_stock AS inStock FROM prices
  WHERE listing_id = ? AND pincode = ? ORDER BY id DESC LIMIT 1`);

const insertPrice = db.prepare(`
  INSERT INTO prices (listing_id, pincode, price, mrp, in_stock, fetched_at, checked_at)
  VALUES (@listingId, @pincode, @price, @mrp, @inStock,
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

const touchPrice = db.prepare(`UPDATE prices SET checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`);

const insertUnmatched = db.prepare(`
  INSERT INTO unmatched (platform, platform_product_id, title, url)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(platform, platform_product_id) DO UPDATE SET title = excluded.title, url = excluded.url`);

// Listings that were last seen in stock at this pincode.
const inStockListings = db.prepare(`
  SELECT l.id AS listingId, p.price, p.mrp, COALESCE(p.checked_at, p.fetched_at) AS checkedAt
  FROM listings l JOIN prices p ON p.listing_id = l.id
  WHERE l.platform = ? AND p.pincode = ? AND p.in_stock = 1
    AND p.id = (SELECT MAX(id) FROM prices WHERE listing_id = l.id AND pincode = p.pincode)`);

/**
 * Keep history compact: a new row is written only when price, MRP or stock
 * changed. Otherwise the latest row's checked_at is refreshed, so "last checked"
 * stays live without storing a row per product every 5 minutes.
 */
function record(listingId: number, pincode: string, price: number, mrp: number | null, inStock: boolean) {
  const flag = inStock ? 1 : 0;
  const last = latestRow.get(listingId, pincode) as
    | { id: number; price: number; mrp: number | null; inStock: number }
    | undefined;
  if (last && last.price === price && (last.mrp ?? null) === mrp && last.inStock === flag) {
    touchPrice.run(last.id);
    return 'unchanged' as const;
  }
  insertPrice.run({ listingId, pincode, price, mrp, inStock: flag });
  return 'changed' as const;
}

const markCrawled = db.prepare(`
  INSERT INTO crawls (platform, pincode, finished_at)
  VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(platform, pincode) DO UPDATE SET finished_at = excluded.finished_at`);

/**
 * Third-party sellers on marketplaces can declare absurd MRPs (a keyring "MRP" of Rs 99,900), which
 * would show as a 99% discount. LEGO is not discounted past about 60%, so a larger gap means the MRP
 * is not trustworthy and is dropped (the price itself is kept).
 */
const MAX_MRP_RATIO = 2.5;
function saneMrp(price: number, mrp: number | null | undefined): number | null {
  return mrp != null && mrp >= price && mrp <= price * MAX_MRP_RATIO ? mrp : null;
}

export interface ScrapeOptions {
  platform?: string;
  pincode?: string;
  /**
   * "fast": quick-commerce adapters (no minIntervalMin), run every few minutes.
   * "slow": heavy retail adapters (minIntervalMin set), run on their own schedule so a long
   * Amazon crawl can never delay the 5 minute loop.
   */
  lane?: 'fast' | 'slow';
  /** Ignore per-platform minimum intervals (used by the CLI). */
  force?: boolean;
  /** The long-running worker keeps Chrome open between runs; the CLI closes it. */
  keepBrowserOpen?: boolean;
  /** How many crawls run at once (defaults to SCRAPE_CONCURRENCY). */
  concurrency?: number;
  /** Called as each platform starts and finishes (drives the website's live refresh progress). */
  onProgress?: (platform: string, progress: PlatformProgress) => void;
}

export type PlatformProgress =
  | { state: 'running' }
  | { state: 'done'; listings: number }
  | { state: 'unserved' }
  | { state: 'failed'; error: string };

interface Catalog {
  known: Set<string>;
  byName: (title: string) => string | null;
}

const RETRY_UNSERVICEABLE_MS = 6 * 3600_000;
const MAX_POINT_ATTEMPTS = Number(process.env.MAX_POINT_ATTEMPTS ?? 10);

interface ServingRow {
  lat: number | null;
  lng: number | null;
  ok: number;
  checked_at: string;
}
const getServing = db.prepare('SELECT lat, lng, ok, checked_at FROM serving WHERE platform = ? AND pincode = ?');
const setServing = db.prepare(`
  INSERT INTO serving (platform, pincode, lat, lng, ok, checked_at)
  VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(platform, pincode) DO UPDATE SET
    lat = excluded.lat, lng = excluded.lng, ok = excluded.ok, checked_at = excluded.checked_at`);

/**
 * Coordinate-keyed platforms (quick commerce) only answer for points inside a delivery area.
 * Reuse the point that worked last time; otherwise try candidate points until one is served.
 * Returns null when the platform does not serve this pincode.
 */
async function fetchAtPincode(adapter: Adapter, pin: Pincode): Promise<RawListing[] | null> {
  if (adapter.locationKey === 'pincode') {
    try {
      return await adapter.fetchLegoListings(pin);
    } catch (err) {
      if (err instanceof NotServiceableError) return null;
      throw err;
    }
  }

  const row = getServing.get(adapter.id, pin.pincode) as ServingRow | undefined;
  if (row && !row.ok && Date.now() - Date.parse(row.checked_at) < RETRY_UNSERVICEABLE_MS) return null;

  const points = candidatePoints(pin.pincode);
  const ordered = row?.ok && row.lat != null && row.lng != null ? [{ lat: row.lat, lng: row.lng }, ...points] : points;

  for (const p of ordered.slice(0, MAX_POINT_ATTEMPTS)) {
    try {
      const listings = await adapter.fetchLegoListings({ ...pin, lat: p.lat, lng: p.lng });
      setServing.run(adapter.id, pin.pincode, p.lat, p.lng, 1);
      return listings;
    } catch (err) {
      if (!(err instanceof NotServiceableError)) throw err;
    }
  }
  setServing.run(adapter.id, pin.pincode, null, null, 0);
  return null;
}

async function scrapeOne(adapter: Adapter, pin: Pincode, catalog: Catalog): Promise<PlatformProgress> {
  const all = await fetchAtPincode(adapter, pin);
  if (!all) {
    console.log(`[scrape] ${adapter.id} ${pin.pincode} (${pin.city}): not serviceable here, will retry later`);
    return { state: 'unserved' };
  }
  // Only genuine LEGO-brand products pass: other brands, "compatible" knock-offs and accessories
  // are dropped here, whatever the platform's search returned.
  const raws = all.filter(isLego).map((r) => ({ ...r, title: cleanTitle(r.title) }));
  let changed = 0;
  let unmatched = 0;
  let delisted = 0;
  const seen = new Set<number>();
  const inStockSets = new Set<string>();

  db.transaction(() => {
    for (const r of raws) {
      // Multi-set bundles are kept out of the set prices (see isBundle).
      const setNumber = isBundle(r.title) ? null : matchByNumber(r.title, catalog.known) ?? catalog.byName(r.title);
      if (!setNumber) {
        insertUnmatched.run(adapter.id, r.platformProductId, r.title, r.url);
        unmatched++;
        continue;
      }
      const row = upsertListing.get({
        setNumber,
        platform: adapter.id,
        productId: r.platformProductId,
        title: r.title,
        url: r.url,
        brand: r.brand ?? null,
      }) as { id: number };
      seen.add(row.id);
      if (r.inStock) inStockSets.add(setNumber);
      if (record(row.id, pin.pincode, r.price, saneMrp(r.price, r.mrp), r.inStock) === 'changed') changed++;
    }

    // A product that was in stock but is no longer returned is gone from this pincode.
    // Only do this after a full, non-empty crawl so a bad response can't wipe stock, and only
    // once it has been missing for a while: search results on big sites shift a little between
    // crawls, and one missed crawl must not flip a product to out of stock and back.
    if (raws.length > 0) {
      const graceMs = Math.max(15, 2 * (adapter.minIntervalMin ?? 5)) * 60_000;
      for (const row of inStockListings.all(adapter.id, pin.pincode) as {
        listingId: number;
        price: number;
        mrp: number | null;
        checkedAt: string;
      }[]) {
        if (seen.has(row.listingId)) continue;
        if (Date.now() - Date.parse(row.checkedAt) < graceMs) continue;
        record(row.listingId, pin.pincode, row.price, row.mrp, false);
        delisted++;
      }
    }
  })();

  console.log(
    `[scrape] ${adapter.id} ${pin.pincode} (${pin.city}): ${all.length} products, ${raws.length} genuine LEGO, ` +
      `${seen.size} matched, ${changed} price/stock changes, ${delisted} gone, ${unmatched} unmatched`,
  );
  // Report distinct sets in stock: the same number the site shows with "In stock only" on.
  return { state: 'done', listings: inStockSets.size };
}

/** Crawl every registered platform for every stored pincode. */
export async function runScrape(opts: ScrapeOptions = {}): Promise<void> {
  const active = adapters
    .filter((a) => !opts.platform || a.id === opts.platform)
    .filter((a) => !opts.lane || (opts.lane === 'slow') === !!a.minIntervalMin);
  // Scheduled runs (a lane is set) skip pincodes nobody has opened recently, so a pile of
  // one-off pincodes can not grow the crawl load forever. Explicit requests crawl regardless.
  const activeSince = new Date(Date.now() - ACTIVE_DAYS * 86_400_000).toISOString();
  const pins = (db.prepare('SELECT * FROM pincodes ORDER BY pincode').all() as (Pincode & { last_viewed_at: string | null })[])
    .filter((p) => !opts.pincode || p.pincode === opts.pincode)
    .filter((p) => !opts.lane || (p.last_viewed_at ?? '') >= activeSince)
    // A live refresh for this pincode is already crawling every store; do not crawl it twice.
    .filter((p) => !opts.lane || !liveRunning.get(p.pincode));
  if (active.length === 0) return console.log('[scrape] no matching adapters');
  if (pins.length === 0) return console.log('[scrape] no pincodes yet. Add one with: npm run cli -- pincode add <pincode>');

  const sets = db.prepare('SELECT set_number, name FROM sets').all() as { set_number: string; name: string }[];
  if (sets.length === 0) return console.log('[scrape] catalog is empty. Run: npm run cli -- catalog');
  const catalog: Catalog = { known: new Set(sets.map((s) => s.set_number)), byName: createNameMatcher(sets) };

  // Skip crawls that ran more recently than the platform's minimum interval.
  const lastCrawl = db.prepare('SELECT finished_at FROM crawls WHERE platform = ? AND pincode = ?');
  const tasks = active
    .flatMap((adapter) => pins.map((pin) => ({ adapter, pin })))
    .filter(({ adapter, pin }) => {
      if (opts.force || !adapter.minIntervalMin) return true;
      const row = lastCrawl.get(adapter.id, pin.pincode) as { finished_at: string } | undefined;
      return !row || Date.now() - Date.parse(row.finished_at) >= adapter.minIntervalMin * 60_000 - 30_000;
    });
  if (tasks.length === 0) return;
  // Heaviest crawls first so they are not the last to start; quick ones fill in around them.
  const weight = (a: Adapter) => (a.minIntervalMin ? 1 : 0);
  tasks.sort((x, y) => weight(y.adapter) - weight(x.adapter));
  const started = Date.now();

  // Small pool: CONCURRENCY crawls at a time, each with a short stagger.
  // Scheduled runs only: a store that keeps failing for a pincode (usually a block on the server's
  // address) is left alone for a growing time instead of being hit again every few minutes, which
  // only makes blocks last longer. The "Fetch live rates" button always tries every store.
  const scheduled = !!opts.lane && !opts.force;
  const queue = tasks.filter((t) => !scheduled || (coolDownUntil.get(`${t.adapter.id}:${t.pin.pincode}`) ?? 0) <= Date.now());
  const skipped = tasks.length - queue.length;
  if (skipped > 0) console.log(`[scrape] resting ${skipped} crawl(s) after repeated failures`);
  const lane = async (index: number) => {
    await sleep(index * 1500);
    for (let t = queue.shift(); t; t = queue.shift()) {
      opts.onProgress?.(t.adapter.id, { state: 'running' });
      try {
        try {
          // Run the crawl first: inside `onProgress?.(...)` the argument would be skipped
          // entirely whenever no callback is passed (the scheduled runs).
          const result = await scrapeOne(t.adapter, t.pin, catalog);
          noteOutcome(t.adapter.id, t.pin.pincode, true);
          opts.onProgress?.(t.adapter.id, result);
        } catch (err) {
          // Sites fail now and then for reasons that clear on a second try (timeouts, a slow page,
          // a bot check, a dropped connection). Retry every failure once with a fresh browser tab;
          // only a second failure is reported. Network-type errors get a longer pause first.
          const msg = (err as Error).message.split('\n')[0];
          console.log(`[scrape] ${t.adapter.id} ${t.pin.pincode} failed once, retrying: ${msg}`);
          await sleep(TRANSIENT.test(msg) ? 15_000 : 5_000);
          const result = await scrapeOne(t.adapter, t.pin, catalog);
          noteOutcome(t.adapter.id, t.pin.pincode, true);
          opts.onProgress?.(t.adapter.id, result);
        }
      } catch (err) {
        noteOutcome(t.adapter.id, t.pin.pincode, false);
        const message = (err as Error).message.split('\n')[0];
        console.error(`[scrape] ${t.adapter.id} ${t.pin.pincode} failed:`, message);
        opts.onProgress?.(t.adapter.id, { state: 'failed', error: message });
      } finally {
        // Record the attempt even on failure so a flaky site waits out its interval
        // instead of being retried on every 5 minute tick.
        markCrawled.run(t.adapter.id, t.pin.pincode);
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? CONCURRENCY, tasks.length) }, (_, i) => lane(i)));
  } finally {
    if (!opts.keepBrowserOpen) await closeBrowser();
  }
  console.log(`[scrape] run finished in ${((Date.now() - started) / 1000).toFixed(1)}s (${tasks.length} crawls)`);
}
