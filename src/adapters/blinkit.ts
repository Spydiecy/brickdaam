import { execFile } from 'node:child_process';
import { NotServiceableError, type Adapter, type Pincode, type RawListing } from '../types.js';
import { newContext } from '../browser.js';

const ORIGIN = 'https://blinkit.com';
const MAX_PAGES = 30;
const PAGE_DELAY_MS = 700;
// Only about 4 in 10 calls to the Worker get through (Blinkit refuses some of Cloudflare's outgoing
// addresses), so a page is asked for up to this many times. 20 tries fail only about 1 in 100,000 pages.
const WORKER_TRIES = 20;

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

/** GET a URL with the system curl. Returns status 0 if curl itself failed (timeout, no network). */
function curlGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const args = ['-s', '-m', '30', '-w', '\n%{http_code}'];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push(url);
  return new Promise((resolve) => {
    execFile('curl', args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve({ status: 0, body: '' });
      const i = stdout.lastIndexOf('\n');
      resolve({ status: Number(stdout.slice(i + 1)) || 0, body: stdout.slice(0, i) });
    });
  });
}

/**
 * Blinkit's firewall blocks cloud servers (AWS) but accepts requests that start inside Cloudflare's
 * network. With BLINKIT_WORKER_URL set, the search requests go through a free Cloudflare Worker
 * (deploy/blinkit-worker.js) that forwards them; this code still does the paging and parsing.
 */
async function viaWorker(pin: Pincode, workerUrl: string, key: string): Promise<RawListing[]> {
  const get = async (next?: string) => {
    const u = new URL(workerUrl);
    u.searchParams.set('lat', String(pin.lat));
    u.searchParams.set('lon', String(pin.lng));
    if (next) u.searchParams.set('next', next);
    // Blinkit refuses some of Cloudflare's outgoing addresses and accepts others, and each call to the
    // Worker leaves from a different one. A 403 therefore just means "bad address this time": ask again.
    // The call is made with curl: Node's own fetch is refused every time from the same machine, while
    // curl gets through most of the time (found by testing; Cloudflare judges the two clients differently).
    let status = 0;
    for (let attempt = 0; attempt < WORKER_TRIES; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, Math.min(300 * attempt, 1500)));
      const res = await curlGet(u.toString(), { 'x-key': key });
      status = res.status;
      if (status === 400) throw new NotServiceableError(`blinkit does not serve (${pin.lat}, ${pin.lng})`);
      if (status === 200) {
        try {
          return JSON.parse(res.body);
        } catch {
          status = 502; // not JSON: treat like a bad answer and ask again
        }
      }
      if (status !== 403 && status !== 0 && status < 500) break;
    }
    throw new Error(`blinkit (via worker) returned HTTP ${status}`);
  };

  const byId = new Map<string, RawListing>();
  let json = await get();
  let next: string | undefined;
  for (let i = 0; ; i++) {
    for (const l of extract(json)) byId.set(l.platformProductId, l);
    next = json?.response?.pagination?.next_url;
    if (!next || i >= MAX_PAGES) break;
    await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    json = await get(next);
  }
  return [...byId.values()];
}

export const blinkit: Adapter = {
  id: 'blinkit',
  name: 'Blinkit',
  locationKey: 'coordinates',
  // Through the Worker a crawl costs about 40 calls, and the free plan allows 100,000 a day, so crawl
  // each pincode every 15 minutes at most. Direct browser crawls keep the normal 5 minute pace.
  ...(process.env.BLINKIT_WORKER_URL ? { minIntervalMin: 15 } : {}),

  async fetchLegoListings(pin: Pincode): Promise<RawListing[]> {
    const workerUrl = process.env.BLINKIT_WORKER_URL;
    if (workerUrl) return viaWorker(pin, workerUrl, process.env.BLINKIT_WORKER_KEY ?? '');

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
