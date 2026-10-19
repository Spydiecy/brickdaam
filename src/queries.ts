import { db } from './db.js';

/**
 * Display names and how long (minutes) before a platform's data counts as stale: about 3x its crawl
 * interval (5 min quick commerce, 15 min BigBasket, 30 min for the heavier crawls).
 */
const PLATFORMS: Record<string, { name: string; staleAfterMin: number }> = {
  blinkit: { name: 'Blinkit', staleAfterMin: 20 },
  zepto: { name: 'Zepto', staleAfterMin: 20 },
  instamart: { name: 'Instamart', staleAfterMin: 90 },
  bigbasket: { name: 'BigBasket', staleAfterMin: 45 },
  ozi: { name: 'Ozi', staleAfterMin: 20 },
  'flipkart-minutes': { name: 'Flipkart Minutes', staleAfterMin: 90 },
  'amazon-now': { name: 'Amazon Now', staleAfterMin: 20 },
  amazon: { name: 'Amazon', staleAfterMin: 90 },
  flipkart: { name: 'Flipkart', staleAfterMin: 90 },
  firstcry: { name: 'FirstCry', staleAfterMin: 90 },
};
const platformInfo = (id: string) => PLATFORMS[id] ?? { name: id, staleAfterMin: 60 };
const platformOrder = (id: string) => {
  const i = Object.keys(PLATFORMS).indexOf(id);
  return i === -1 ? 999 : i;
};

/**
 * Latest price per listing for one set at one pincode: in stock first, then cheapest.
 * checkedAt = last time a crawl confirmed it; changedAt = when this price/stock began.
 */
export function latestPrices(setNumber: string, pincode: string) {
  return db
    .prepare(
      `SELECT l.platform, l.title, l.url, p.price, p.mrp,
              p.in_stock AS inStock,
              COALESCE(p.checked_at, p.fetched_at) AS checkedAt,
              p.fetched_at AS changedAt
       FROM listings l
       JOIN prices p ON p.listing_id = l.id
       WHERE l.set_number = ? AND p.pincode = ?
         AND p.id = (SELECT MAX(id) FROM prices WHERE listing_id = l.id AND pincode = p.pincode)
       ORDER BY p.in_stock DESC, p.price ASC`,
    )
    .all(setNumber, pincode);
}

interface Offer {
  title: string;
  url: string;
  price: number;
  mrp: number | null;
  inStock: boolean;
  checkedAt: string;
  changedAt: string;
}

/** Everything the price matrix needs for one pincode, in a single response. */
export function pincodeOverview(pincode: string) {
  const pin = db.prepare('SELECT pincode, city FROM pincodes WHERE pincode = ?').get(pincode) as
    | { pincode: string; city: string }
    | undefined;
  if (!pin) return null;

  const rows = db
    .prepare(
      `SELECT s.set_number AS setNumber, s.name, s.theme, s.pieces, s.year, s.img_url AS imgUrl,
              l.platform, l.title, l.url, p.price, p.mrp, p.in_stock AS inStock,
              COALESCE(p.checked_at, p.fetched_at) AS checkedAt, p.fetched_at AS changedAt
       FROM listings l
       JOIN sets s ON s.set_number = l.set_number
       JOIN prices p ON p.listing_id = l.id
        AND p.id = (SELECT MAX(id) FROM prices WHERE listing_id = l.id AND pincode = p.pincode)
       WHERE p.pincode = ?`,
    )
    .all(pincode) as any[];

  const lastChecked = new Map<string, string>();
  const sets = new Map<string, any>();

  for (const r of rows) {
    if (!lastChecked.has(r.platform) || r.checkedAt > lastChecked.get(r.platform)!) {
      lastChecked.set(r.platform, r.checkedAt);
    }
    let s = sets.get(r.setNumber);
    if (!s) {
      s = { setNumber: r.setNumber, name: r.name, theme: r.theme, pieces: r.pieces, year: r.year, imgUrl: r.imgUrl, offers: {} };
      sets.set(r.setNumber, s);
    }
    const offer: Offer = {
      title: r.title,
      url: r.url,
      price: r.price,
      mrp: r.mrp,
      inStock: !!r.inStock,
      checkedAt: r.checkedAt,
      changedAt: r.changedAt,
    };
    // A platform can list the same set more than once; keep its best offer.
    const cur: Offer | undefined = s.offers[r.platform];
    const better =
      !cur || (offer.inStock && !cur.inStock) || (offer.inStock === cur.inStock && offer.price < cur.price);
    if (better) s.offers[r.platform] = offer;
  }

  const list = [...sets.values()].map((s) => {
    let best: { platform: string; price: number; mrp: number | null; url: string } | null = null;
    for (const [platform, o] of Object.entries<Offer>(s.offers)) {
      if (o.inStock && (!best || o.price < best.price)) best = { platform, price: o.price, mrp: o.mrp, url: o.url };
    }
    // Marketplace sellers sometimes inflate MRP to fake a big discount. The real MRP of a LEGO set
    // is the same everywhere, so measure the discount against the lowest MRP any store shows.
    const mrps = Object.values<Offer>(s.offers)
      .map((o) => o.mrp)
      .filter((m): m is number => m != null && m > 0);
    const refMrp = mrps.length ? Math.min(...mrps) : null;
    if (best && refMrp != null) best.mrp = refMrp >= best.price ? refMrp : null;
    const discount = best?.mrp && best.mrp > best.price ? Math.round((1 - best.price / best.mrp) * 100) : null;
    return { ...s, best, discount };
  });

  const platforms = [...lastChecked.keys()]
    .sort((a, b) => platformOrder(a) - platformOrder(b))
    .map((id) => ({
      id,
      name: platformInfo(id).name,
      lastChecked: lastChecked.get(id)!,
      staleAfterMin: platformInfo(id).staleAfterMin,
    }));

  const unserved = (
    db.prepare('SELECT platform FROM serving WHERE pincode = ? AND ok = 0').all(pincode) as { platform: string }[]
  ).map((r) => ({ id: r.platform, name: platformInfo(r.platform).name }));

  return { pincode: pin.pincode, city: pin.city, platforms, unserved, sets: list };
}

/** Price history for one set at one pincode (one row per change). */
export function priceHistory(setNumber: string, pincode: string) {
  const rows = db
    .prepare(
      `SELECT l.id AS listingId, l.platform, p.price, p.mrp, p.in_stock AS inStock, p.fetched_at AS at
       FROM listings l JOIN prices p ON p.listing_id = l.id
       WHERE l.set_number = ? AND p.pincode = ?
       ORDER BY p.fetched_at, p.id`,
    )
    .all(setNumber, pincode) as { listingId: number; platform: string; price: number; mrp: number | null; inStock: number; at: string }[];

  // Rows written before change-only logging can repeat the same state; show real changes only.
  const last = new Map<number, string>();
  return rows
    .filter((r) => {
      const state = `${r.price}|${r.mrp}|${r.inStock}`;
      if (last.get(r.listingId) === state) return false;
      last.set(r.listingId, state);
      return true;
    })
    .map(({ listingId, ...rest }) => rest);
}

/** Display name for a platform id. */
export const platformName = (id: string) => platformInfo(id).name;

/**
 * One platform's current LEGO listings at a pincode, cheapest in-stock first.
 * Read from the database the worker keeps fresh, so it answers instantly.
 */
export function platformListings(platform: string, pincode: string) {
  return db
    .prepare(
      `SELECT l.set_number AS setNumber, s.name AS setName, s.theme, l.title, l.url,
              p.price, p.mrp, p.in_stock AS inStock,
              COALESCE(p.checked_at, p.fetched_at) AS checkedAt, p.fetched_at AS changedAt
       FROM listings l
       JOIN sets s ON s.set_number = l.set_number
       JOIN prices p ON p.listing_id = l.id
        AND p.id = (SELECT MAX(id) FROM prices WHERE listing_id = l.id AND pincode = p.pincode)
       WHERE l.platform = ? AND p.pincode = ?
       ORDER BY p.in_stock DESC, p.price ASC`,
    )
    .all(platform, pincode)
    .map((r: any) => ({ ...r, inStock: !!r.inStock }));
}

/** Per platform, at a pincode: how many listings, when it was last crawled, and whether it serves there. */
export function platformStatus(platformIds: string[], pincode: string) {
  const counts = db.prepare(
    `SELECT COUNT(*) AS listings, SUM(p.in_stock) AS inStock, MAX(COALESCE(p.checked_at, p.fetched_at)) AS lastChecked
     FROM listings l JOIN prices p ON p.listing_id = l.id
      AND p.id = (SELECT MAX(id) FROM prices WHERE listing_id = l.id AND pincode = p.pincode)
     WHERE l.platform = ? AND p.pincode = ?`,
  );
  const crawl = db.prepare('SELECT finished_at FROM crawls WHERE platform = ? AND pincode = ?');
  const serving = db.prepare('SELECT ok FROM serving WHERE platform = ? AND pincode = ?');
  return platformIds.map((id) => {
    const c = counts.get(id, pincode) as { listings: number; inStock: number | null; lastChecked: string | null };
    const s = serving.get(id, pincode) as { ok: number } | undefined;
    const lastAttempt = (crawl.get(id, pincode) as { finished_at: string } | undefined)?.finished_at ?? null;
    return {
      id,
      name: platformName(id),
      listings: c.listings,
      inStock: c.inStock ?? 0,
      lastChecked: c.lastChecked,
      lastAttempt,
      serves: s ? !!s.ok : null,
    };
  });
}

/** Everything the set page needs: catalog info, every store's latest offer, and price changes. */
export function setDetail(setNumber: string, pincode: string) {
  const set = db
    .prepare(
      `SELECT set_number AS setNumber, name, theme, pieces, year, img_url AS imgUrl FROM sets WHERE set_number = ?`,
    )
    .get(setNumber);
  if (!set) return null;
  const offers = (latestPrices(setNumber, pincode) as any[]).map((o) => ({
    ...o,
    name: platformName(o.platform),
    inStock: !!o.inStock,
  }));
  const history = (priceHistory(setNumber, pincode) as any[]).map((h) => ({
    ...h,
    name: platformName(h.platform),
    inStock: !!h.inStock,
  }));
  return { set, offers, history };
}
