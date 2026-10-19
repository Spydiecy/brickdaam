import { NotServiceableError, type Adapter, type Pincode, type RawListing } from '../types.js';
import { newContext } from '../browser.js';

const ORIGIN = 'https://blinkit.com';
const MAX_PAGES = 30;
const PAGE_DELAY_MS = 700;

// Headers the browser sets itself (or that fetch() refuses to set).
const SKIP_HEADERS = /^(:|host$|content-length$|cookie$|origin$|referer$|user-agent$|accept-encoding$|connection$|priority$|sec-)/i;

const rupees = (t: unknown): number | null => {
  const m = String(t ?? '').replace(/,/g, '').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Pull product cards out of one /v1/layout/search response. */
function extract(json: any): RawListing[] {
  const out: RawListing[] = [];
  for (const s of json?.response?.snippets ?? []) {
    if (!String(s?.widget_type).startsWith('product_card')) continue;
    const d = s.data ?? {};
    const item = d.atc_action?.add_to_cart?.cart_item;
    let productId: string | null = item?.product_id != null ? String(item.product_id) : null;
    if (!productId) {
      try {
        productId = new URL(d.click_action?.blinkit_deeplink?.url).searchParams.get('product_id');
      } catch { /* no deeplink */ }
    }
    const title: string | undefined = item?.product_name ?? d.name?.text;
    const price = item?.price ?? rupees(d.normal_price?.text);
    if (!productId || !title || price == null) continue;
    const mrp = item?.mrp ?? rupees(d.mrp?.text);
    const stock = Number(item?.inventory ?? d.inventory ?? 0);
    out.push({
      platformProductId: productId,
      title,
      brand: item?.brand ?? null,
      price,
      mrp: mrp ?? null,
      inStock: !d.is_sold_out && stock > 0,
      url: `${ORIGIN}/prn/${slug(title)}/prid/${productId}`,
    });
  }
  return out;
}

export const blinkit: Adapter = {
  id: 'blinkit',
  name: 'Blinkit',
  locationKey: 'coordinates',

  async fetchLegoListings(pin: Pincode): Promise<RawListing[]> {
    const ctx = await newContext();
    try {
      await ctx.addCookies([
        { name: 'gr_1_lat', value: String(pin.lat), domain: 'blinkit.com', path: '/' },
        { name: 'gr_1_lon', value: String(pin.lng), domain: 'blinkit.com', path: '/' },
      ]);
      const page = await ctx.newPage();

      // Blinkit picks the dark store from the lat/lon request headers.
      const geo = { lat: String(pin.lat), lon: String(pin.lng) };
      await page.route('**/v1/layout/**', (route) =>
        route.continue({ headers: { ...route.request().headers(), ...geo } }),
      );

      let template: Record<string, string> | null = null;
      page.on('request', async (req) => {
        if (!template && req.url().includes('/v1/layout/search?q=')) {
          template = await req.allHeaders();
        }
      });

      const first = page.waitForResponse((r) => r.url().includes('/v1/layout/search?q='), { timeout: 45000 });
      await page.goto(`${ORIGIN}/s/?q=lego`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const firstRes = await first;
      if (!firstRes.ok()) {
        // HTTP 400 means this point is outside every Blinkit delivery area
        if (firstRes.status() === 400) {
          throw new NotServiceableError(`blinkit does not serve (${pin.lat}, ${pin.lng})`);
        }
        throw new Error(`blinkit search returned HTTP ${firstRes.status()}`);
      }
      const firstJson = await firstRes.json();
      await page.waitForTimeout(500);

      const headers: Record<string, string> = { ...geo };
      for (const [k, v] of Object.entries((template ?? {}) as Record<string, string>)) {
        if (!SKIP_HEADERS.test(k) && k !== 'lat' && k !== 'lon') headers[k] = v;
      }

      const byId = new Map<string, RawListing>();
      const add = (json: unknown) => {
        for (const l of extract(json)) byId.set(l.platformProductId, l);
      };
      add(firstJson);

      let next: string | undefined = firstJson?.response?.pagination?.next_url;
      for (let i = 0; next && i < MAX_PAGES; i++) {
        await page.waitForTimeout(PAGE_DELAY_MS);
        const res = await page.evaluate(
          async ({ url, headers }) => {
            const r = await fetch(url, { method: 'POST', headers, credentials: 'include' });
            return { status: r.status, body: r.ok ? await r.json() : null };
          },
          { url: next, headers },
        );
        if (!res.body) throw new Error(`blinkit paging failed: HTTP ${res.status}`);
        add(res.body);
        next = res.body?.response?.pagination?.next_url;
      }
      return [...byId.values()];
    } finally {
      await ctx.close();
    }
  },
};
