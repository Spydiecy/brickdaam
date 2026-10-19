import { NotServiceableError, type Adapter, type Pincode, type RawListing } from '../types.js';
import type { BrowserContext } from 'playwright';
import { newContext } from '../browser.js';
import { isLego } from '../match.js';

const ORIGIN = 'https://www.zepto.com';
const SEARCH_URL = 'https://bff-gateway.zepto.com/user-search-service/api/v3/search';
const QUERY = 'lego';
const MAX_PAGES = 25;
const PAGE_DELAY_MS = 900;
const FIRST_RESPONSE_TIMEOUT_MS = 40_000;

// Headers the browser sets itself (or that fetch() refuses to set).
const SKIP_HEADERS = /^(:|host$|content-length$|cookie$|origin$|referer$|user-agent$|accept-encoding$|connection$|priority$|sec-)/i;

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Zepto prices are integer paise. */
const rupees = (paise: unknown): number | null => {
  const n = Number(paise);
  return Number.isFinite(n) && n > 0 ? n / 100 : null;
};


/** The dark store Zepto's server picked for the user_position cookie (from its "serviceability" cookie). */
async function servingStore(ctx: BrowserContext): Promise<{ serviceable: boolean; storeId?: string } | null> {
  const cookie = (await ctx.cookies(ORIGIN)).find((c) => c.name === 'serviceability');
  if (!cookie) return null;
  try {
    const primary = JSON.parse(decodeURIComponent(cookie.value))?.primaryStore;
    return { serviceable: primary?.serviceable === true && typeof primary?.storeId === 'string', storeId: primary?.storeId };
  } catch {
    return null;
  }
}

/** Pull product cards out of one /user-search-service/api/v3/search response. */
function extract(json: any): RawListing[] {
  const out: RawListing[] = [];
  for (const widget of json?.layout ?? []) {
    if (widget?.widgetId !== 'PRODUCT_GRID') continue;
    for (const item of widget?.data?.resolver?.data?.items ?? []) {
      const p = item?.productResponse;
      const product = p?.product;
      const variant = p?.productVariant;
      const variantId: string | undefined = variant?.id ?? undefined;
      const title: string | undefined = product?.name;
      const price = rupees(p?.discountedSellingPrice) ?? rupees(p?.sellingPrice);
      if (!variantId || !title || price == null) continue;
      const mrp = rupees(p?.mrp) ?? rupees(variant?.mrp);
      const qty = Number(p?.availableQuantity ?? 0);
      out.push({
        platformProductId: variantId,
        title,
        brand: product?.brand ?? null,
        price,
        mrp: mrp != null && mrp >= price ? mrp : null,
        inStock: !p?.outOfStock && qty > 0,
        url: `${ORIGIN}/pn/${slug(title)}/pvid/${variantId}`,
      });
    }
  }
  return out;
}

export const zepto: Adapter = {
  id: 'zepto',
  name: 'Zepto',
  locationKey: 'coordinates',

  async fetchLegoListings(pin: Pincode): Promise<RawListing[]> {
    const ctx = await newContext();
    try {
      // Zepto's server renders the page for the store serving the "user_position" cookie.
      await ctx.addCookies([
        {
          name: 'user_position',
          value: encodeURIComponent(JSON.stringify({ latitude: pin.lat, longitude: pin.lng })),
          domain: 'www.zepto.com',
          path: '/',
        },
      ]);
      const page = await ctx.newPage();

      let template: Record<string, string> | null = null;
      page.on('request', async (req) => {
        if (!template && req.url() === SEARCH_URL && req.method() === 'POST') template = await req.allHeaders();
      });

      const firstResponse = page
        .waitForResponse((r) => r.url() === SEARCH_URL, { timeout: FIRST_RESPONSE_TIMEOUT_MS })
        .catch(() => null);
      const nav = await page.goto(`${ORIGIN}/search?query=${QUERY}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (nav && nav.status() >= 400) throw new Error(`zepto page returned HTTP ${nav.status()}`);

      let first = await firstResponse;
      // Zepto sometimes renders without firing its search (slow script or a bot-check pass).
      // Reload up to twice before deciding anything.
      for (let attempt = 1; !first && attempt <= 2; attempt++) {
        const again = page
          .waitForResponse((r) => r.url() === SEARCH_URL, { timeout: FIRST_RESPONSE_TIMEOUT_MS })
          .catch(() => null);
        await page.waitForTimeout(2000 * attempt);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
        first = await again;
      }
      const store = await servingStore(ctx);
      if (!first) {
        // No search call at all: either the point is outside every Zepto delivery area, or the page broke.
        if (store && !store.serviceable) throw new NotServiceableError(`zepto does not serve (${pin.lat}, ${pin.lng})`);
        throw new Error('zepto did not issue a search request (layout change, block, or slow load)');
      }
      // For a point outside every delivery area Zepto still runs the search, but against a default
      // store and with no serviceable store in its "serviceability" cookie. Those results are not
      // for this location, so only accept them when the cookie confirms a serviceable primary store.
      if (!store?.serviceable) throw new NotServiceableError(`zepto does not serve (${pin.lat}, ${pin.lng})`);
      if (!first.ok()) throw new Error(`zepto search returned HTTP ${first.status()}`);
      const firstJson: any = await first.json();
      await page.waitForTimeout(500);

      const tmpl = template as Record<string, string> | null;
      if (!tmpl) throw new Error('zepto: could not capture the search request headers');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(tmpl)) if (!SKIP_HEADERS.test(k)) headers[k] = v;

      const byId = new Map<string, RawListing>();
      const add = (json: unknown) => {
        for (const l of extract(json)) {
          const prev = byId.get(l.platformProductId);
          // The same product can show up from both the primary and secondary store: keep the one in stock.
          if (!prev || (!prev.inStock && l.inStock)) byId.set(l.platformProductId, l);
        }
      };
      add(firstJson);

      let json: any = firstJson;
      for (let i = 1; i < MAX_PAGES && json && json.hasReachedEnd === false; i++) {
        const nextPage = json?.nextPageParams?.pageNumber;
        if (typeof nextPage !== 'number') break;
        await page.waitForTimeout(PAGE_DELAY_MS);
        const res = await page.evaluate(
          async ({ url, headers, query, pageNumber }) => {
            const r = await fetch(url, {
              method: 'POST',
              headers,
              credentials: 'include',
              body: JSON.stringify({
                query,
                pageNumber,
                mode: 'SHOW_ALL_RESULTS',
                userSessionId: headers['session_id'],
              }),
            });
            return { status: r.status, body: r.ok ? await r.json() : null };
          },
          { url: SEARCH_URL, headers, query: QUERY, pageNumber: nextPage },
        );
        if (!res.body) throw new Error(`zepto paging failed at page ${nextPage}: HTTP ${res.status}`);
        json = res.body;
        add(json);
      }
      if (json && json.hasReachedEnd === false) {
        throw new Error(`zepto: search still had more pages after ${MAX_PAGES} pages`);
      }
      return [...byId.values()].filter(isLego);
    } finally {
      await ctx.close();
    }
  },
};
