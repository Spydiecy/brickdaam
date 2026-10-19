import type { Page } from 'playwright';
import { db } from '../db.js';
import { NotServiceableError, type Adapter, type Pincode, type RawListing } from '../types.js';
import { newContext } from '../browser.js';

/**
 * Swiggy Instamart. Location comes from the `userLocation` cookie (lat/lng); the search call also
 * carries the dark store ids the page resolves for that point.
 *
 * COVERAGE IS PARTIAL BY NATURE. Instamart's search returns only the ~30-40 best matches for any
 * query, with no working way to page through all of them (filters drop items that lack metadata,
 * extra pages add a handful). To get most of the range we union:
 *   1. the plain "lego" query,
 *   2. "lego <theme>" for the biggest LEGO themes in the catalog, and
 *   3. "lego <set number>" for sets that another quick-commerce app currently has in stock.
 * On a Gurugram store a single "lego" search showed 29 items; this union found 111.
 * Sets that no other tracked platform lists and that no theme query surfaces can still be missed.
 */
const ORIGIN = 'https://www.swiggy.com';
const SEARCH_PATH = '/api/instamart/search/v2';
const REQUEST_DELAY_MS = 300;
const QUERY_LANES = 3; // searches in flight at once
const MAX_SET_QUERIES = 320;
const MAX_THEMES = 45;
const EXCLUDED_THEMES = new Set([
  'Gear', 'Other', 'Promotional', 'Seasonal', 'Editions', 'Xtra', 'LEGO Exclusive', 'Legoland Parks',
  'LEGO Brand Store', 'BrickLink Designer Program', 'Educational and Dacta', 'FIRST LEGO League', 'Power Functions',
]);
const QUICK_COMMERCE = ['blinkit', 'zepto', 'ozi', 'bigbasket'];

const money = (m: { units?: string; nanos?: number } | null | undefined): number | null => {
  if (!m || m.units == null) return null;
  const n = Number(m.units) + (m.nanos ?? 0) / 1e9;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Queries to run, most general first. Built from the catalog and what other platforms stock. */
function buildQueries(): string[] {
  const themes = (
    db
      .prepare(
        `SELECT theme FROM sets WHERE year >= 2020 AND theme <> '' GROUP BY theme ORDER BY COUNT(*) DESC LIMIT ?`,
      )
      .all(MAX_THEMES + EXCLUDED_THEMES.size) as { theme: string }[]
  )
    .map((r) => r.theme)
    .filter((t) => !EXCLUDED_THEMES.has(t))
    .slice(0, MAX_THEMES);

  const placeholders = QUICK_COMMERCE.map(() => '?').join(',');
  const setNumbers = (
    db
      .prepare(
        `SELECT DISTINCT l.set_number AS n
         FROM listings l JOIN prices p ON p.listing_id = l.id
          AND p.id = (SELECT MAX(id) FROM prices WHERE listing_id = l.id AND pincode = p.pincode)
         WHERE p.in_stock = 1 AND l.platform IN (${placeholders})
         ORDER BY l.set_number LIMIT ?`,
      )
      .all(...QUICK_COMMERCE, MAX_SET_QUERIES) as { n: string }[]
  ).map((r) => r.n);

  return ['lego', ...themes.map((t) => `lego ${t}`), ...setNumbers.map((n) => `lego ${n}`)];
}

interface SearchCtx {
  page: Page;
  headers: Record<string, string>;
  storeQuery: string;
}

function search(c: SearchCtx, query: string): Promise<{ status: number; items: any[] }> {
  return c.page.evaluate(
    async ({ query, headers, storeQuery }) => {
      const r = await fetch(`/api/instamart/search/v2?offset=0&ageConsent=false&voiceSearchTrackingId=&${storeQuery}`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          facets: [],
          sortAttribute: '',
          query,
          search_results_offset: '0',
          page_type: 'INSTAMART_SEARCH_PAGE',
          is_pre_search_tag: false,
        }),
      });
      const j: any = await r.json().catch(() => null);
      const items = (j?.data?.cards ?? []).flatMap((card: any) => card?.card?.card?.gridElements?.infoWithStyle?.items ?? []);
      return { status: r.status, items };
    },
    { query, headers: c.headers, storeQuery: c.storeQuery },
  );
}

function toListing(item: any): RawListing | null {
  if (!/^lego$/i.test(String(item?.brand ?? '').trim())) return null; // search also returns other brands
  const v = item?.variations?.[0];
  // The product page URL (/instamart/item/<id>) uses the item's productId.
  const productId: string | undefined = item?.productId;
  const title = String(item?.displayName ?? v?.displayName ?? '').trim();
  const price = money(v?.price?.offerPrice) ?? money(v?.price?.mrp);
  if (!productId || !title || price == null) return null;
  const mrp = money(v?.price?.mrp);
  const inStock = item?.inStock !== false && item?.isAvail !== false && v?.inventory?.inStock !== false;
  return {
    platformProductId: productId,
    title,
    brand: item.brand,
    price,
    mrp: mrp != null && mrp >= price ? mrp : null,
    inStock,
    url: `${ORIGIN}/instamart/item/${productId}`,
  };
}

export const instamart: Adapter = {
  id: 'instamart',
  name: 'Instamart',
  locationKey: 'coordinates',
  // A crawl is a few hundred searches, so it runs on the slow lane rather than every 5 minutes.
  minIntervalMin: 30,

  async fetchLegoListings(pin: Pincode): Promise<RawListing[]> {
    const ctx = await newContext();
    try {
      await ctx.addCookies([
        {
          name: 'userLocation',
          value: encodeURIComponent(
            JSON.stringify({ lat: pin.lat, lng: pin.lng, address: '', area: '', showUserDefaultAddressHint: false }),
          ),
          domain: '.swiggy.com',
          path: '/',
        },
      ]);
      const page = await ctx.newPage();

      // The page's own first search shows whether a store serves this point: a served point
      // returns product cards, an unserved one returns an empty page.
      const first = page
        .waitForResponse((r) => r.url().includes(SEARCH_PATH), { timeout: 45000 })
        .catch(() => null);

      const nav = await page.goto(`${ORIGIN}/instamart/search?custom_back=true&query=lego`, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      if (nav && nav.status() >= 500) throw new Error(`instamart returned HTTP ${nav.status()}`);

      const firstRes = await first;
      if (!firstRes) throw new Error('instamart did not issue a search request (block or layout change)');
      const template = await firstRes.request().allHeaders();
      if (!firstRes.ok()) throw new Error(`instamart search returned HTTP ${firstRes.status()}`);
      let firstJson: any = await firstRes.json().catch(() => null);
      if (!firstJson || firstJson.statusCode !== 0) {
        // Usually a bot-check page served in place of results; one reload normally clears it.
        const again = page.waitForResponse((r) => r.url().includes(SEARCH_PATH), { timeout: 45000 }).catch(() => null);
        await page.waitForTimeout(3000);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
        const r2 = await again;
        firstJson = r2 ? await r2.json().catch(() => null) : null;
        if (!firstJson || firstJson.statusCode !== 0) throw new Error('instamart search returned an unexpected body');
      }
      if (!(firstJson.data?.cards ?? []).length) {
        throw new NotServiceableError(`instamart has no store for (${pin.lat}, ${pin.lng})`);
      }

      // Later searches use the same (empty) store ids the page itself sent: the server
      // resolves the store from the location cookie.
      const storeQuery = 'storeId=&primaryStoreId=&secondaryStoreId=';
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(template)) {
        if (/^(matcher|x-build-version|x-device-id|content-type)$/i.test(k)) headers[k] = v;
      }
      const sc: SearchCtx = { page, headers, storeQuery };

      const byId = new Map<string, RawListing>();
      let failures = 0;
      const queue = buildQueries();
      // A few searches at a time from the same page. A 202 is Swiggy's bot-check answer under load:
      // back off and retry that query rather than counting it as lost.
      const lane = async (i: number) => {
        await page.waitForTimeout(i * 250);
        for (let q = queue.shift(); q; q = queue.shift()) {
          let res = await search(sc, q);
          for (let retry = 1; res.status !== 200 && retry <= 2; retry++) {
            await page.waitForTimeout(1500 * retry);
            res = await search(sc, q);
          }
          if (res.status !== 200) {
            // A run of these means we are being limited or blocked.
            if (++failures >= 6) throw new Error(`instamart search failing (HTTP ${res.status}) after ${byId.size} items`);
          } else {
            for (const item of res.items) {
              const l = toListing(item);
              if (l) byId.set(l.platformProductId, l);
            }
          }
          await page.waitForTimeout(REQUEST_DELAY_MS);
        }
      };
      await Promise.all(Array.from({ length: QUERY_LANES }, (_, i) => lane(i)));
      if (byId.size === 0) throw new Error('instamart returned no LEGO items (store may carry none, or layout change)');
      return [...byId.values()];
    } finally {
      await ctx.close();
    }
  },
};
