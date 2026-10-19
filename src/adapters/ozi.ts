import { NotServiceableError, type Adapter, type Pincode, type RawListing } from '../types.js';
import { newContext } from '../browser.js';

const ORIGIN = 'https://ozi.in';
const ZONE_API = 'https://consumer-service.ozi.in/api/v1/config/get-zone-id';
const PAGE_SIZE = 20; // what the site itself asks for
const MAX_PAGES = 25;
const PAGE_DELAY_MS = 700;

interface InPage {
  status: number;
  body: any;
}

/**
 * Ozi (ozi.in) is a Delhi NCR quick-commerce app. The location is a delivery "zone":
 *  1. the site turns lat/lng into a zone id with consumer-service.ozi.in/api/v1/config/get-zone-id
 *     (HTTP 404 "Service not available in this area" when the point is not served), and
 *  2. every search call carries that zone in a `zoneid: [N]` header (the web app does the same
 *     after "Allow location"). Prices and stock in /api/search are computed for that zone.
 */
export const ozi: Adapter = {
  id: 'ozi',
  name: 'Ozi',
  locationKey: 'coordinates',

  async fetchLegoListings(pin: Pincode): Promise<RawListing[]> {
    const ctx = await newContext();
    try {
      const page = await ctx.newPage();
      // Visit the site first so the in-page requests carry the normal cookies and origin.
      await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1500);

      const zoneRes: InPage = await page.evaluate(
        async ({ url, lat, lng }) => {
          const r = await fetch(`${url}?lat=${lat}&lng=${lng}`, { headers: { accept: 'application/json' } });
          let body: any = null;
          try {
            body = await r.json();
          } catch {
            /* not json */
          }
          return { status: r.status, body };
        },
        { url: ZONE_API, lat: pin.lat, lng: pin.lng },
      );
      if (zoneRes.status === 404) {
        throw new NotServiceableError(`ozi does not serve (${pin.lat}, ${pin.lng})`);
      }
      const zoneIds: number[] = zoneRes.body?.zone_id ?? [];
      const zoneActive = (zoneRes.body?.zone_data ?? []).some((z: any) => z?.status === 1);
      if (zoneRes.status !== 200 || zoneIds.length === 0) {
        throw new Error(`ozi zone lookup failed: HTTP ${zoneRes.status}`);
      }
      if (!zoneActive) throw new NotServiceableError(`ozi zone ${zoneIds.join(',')} is not active`);
      const zoneHeader = `[${zoneIds.join(',')}]`;

      const byId = new Map<string, RawListing>();
      let reportedTotal: number | null = null;
      for (let n = 1; n <= MAX_PAGES; n++) {
        if (n > 1) await page.waitForTimeout(PAGE_DELAY_MS);
        const res: InPage = await page.evaluate(
          async ({ n, size, zone }) => {
            const r = await fetch(`/api/search?keyword=lego&page=${n}&limit=${size}&clicked_suggestion=0`, {
              headers: { accept: 'application/json', zoneid: zone },
              credentials: 'include',
            });
            let body: any = null;
            try {
              body = await r.json();
            } catch {
              /* not json */
            }
            return { status: r.status, body };
          },
          { n, size: PAGE_SIZE, zone: zoneHeader },
        );
        if (res.status !== 200 || !Array.isArray(res.body?.hits?.hits)) {
          throw new Error(`ozi search page ${n} failed: HTTP ${res.status}`);
        }
        reportedTotal ??= res.body.meta?.raw_total ?? null;

        for (const hit of res.body.hits.hits) {
          const l = toListing(hit, zoneIds);
          if (l) byId.set(l.platformProductId, l);
        }
        if (!res.body.meta?.has_next_page) return finish(byId, n, reportedTotal);
      }
      throw new Error(`ozi search still had more pages after ${MAX_PAGES}; layout change?`);
    } finally {
      await ctx.close();
    }
  },
};

function finish(byId: Map<string, RawListing>, pages: number, reportedTotal: number | null): RawListing[] {
  const out = [...byId.values()];
  // The site's own "N products" header counts the zone's in-stock results; if we got fewer
  // listings than that, something was lost on the way.
  const inStock = out.filter((l) => l.inStock).length;
  if (reportedTotal != null && inStock < reportedTotal * 0.9) {
    throw new Error(`ozi returned ${inStock} in-stock LEGO items over ${pages} pages but the site reports ${reportedTotal}`);
  }
  return out;
}

/** One /api/search hit -> RawListing. Returns null for non-LEGO products or unusable rows. */
function toListing(hit: any, zoneIds: number[]): RawListing | null {
  const s = hit?._source;
  // Search also returns other brands that merely mention "lego" (e.g. a pencil sharpener by
  // another brand), so require the brand itself to be LEGO.
  if (!s || !/^lego$/i.test(String(s.brand_name ?? '').trim())) return null;

  const id = String(s.item_id ?? s.id ?? hit._id ?? '');
  const title = String(s.name ?? '').trim();
  const price = Number(s.final_price);
  if (!id || !title || !Number.isFinite(price) || price <= 0) return null;

  const variant = Array.isArray(s.variants) ? s.variants[0] : null;
  const stock = Number(s.stock ?? variant?.available_stock ?? 0);
  const inStock = s.available === true && stock > 0;

  // Search also appends items that are out of stock in this zone after the in-stock block.
  // Keep those only if the zone has its own price for them (i.e. the zone lists the product).
  if (!inStock) {
    const zonePrices = variant?.zone_prices ?? {};
    if (!zoneIds.some((z) => zonePrices[String(z)])) return null;
  }

  const mrp = Number(s.item_price);
  return {
    platformProductId: id,
    title,
    brand: s.brand_name ?? null,
    price,
    mrp: Number.isFinite(mrp) && mrp >= price ? mrp : null,
    inStock,
    url: `${ORIGIN}/product/${s.slug || `product-${id}`}`,
  };
}
