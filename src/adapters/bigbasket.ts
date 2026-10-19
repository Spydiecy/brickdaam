import type { Page } from 'playwright';
import { NotServiceableError, type Adapter, type Pincode, type RawListing } from '../types.js';
import { newContext } from '../browser.js';
import { candidatePoints } from '../geo.js';

const ORIGIN = 'https://www.bigbasket.com';
const MAX_PAGES = 20;
const PAGE_DELAY_MS = 900;

interface InPage {
  status: number;
  body: any;
}

/** fetch() from inside the page so the request carries the site's own cookies and bot-check state. */
function call(
  page: Page,
  url: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<InPage> {
  return page.evaluate(
    async ({ url, init }) => {
      const headers: Record<string, string> = { ...(init?.headers ?? {}) };
      if (init?.body) headers['content-type'] = 'application/json';
      const r = await fetch(url, {
        method: init?.method ?? 'GET',
        credentials: 'include',
        headers,
        body: init?.body ? JSON.stringify(init.body) : undefined,
      });
      let body: any = null;
      try {
        body = await r.json();
      } catch {
        /* empty or not json */
      }
      return { status: r.status, body };
    },
    { url, init },
  );
}

/**
 * Set the delivery location the way the site does when a shopper types a pincode:
 * places autocomplete -> place details (BigBasket's own coordinates for the pincode)
 * -> serviceability check -> "current delivery address" call, which sets the location cookies.
 */
async function setPincode(page: Page, pincode: string): Promise<void> {
  const token = crypto.randomUUID();
  const ac = await call(page, `/places/v1/places/autocomplete/?inputText=${pincode}&token=${token}`);
  if (ac.status !== 200) throw new Error(`bigbasket autocomplete failed: HTTP ${ac.status}`);
  const pred = (ac.body?.predictions ?? []).find((p: any) => p?.mainText === pincode);
  if (!pred) throw new NotServiceableError(`bigbasket does not know pincode ${pincode}`);

  const det = await call(page, `/places/v1/places/details/?placeId=${pred.placeId}&token=${token}`);
  const loc = det.body?.geometry?.location;
  if (det.status !== 200 || typeof loc?.lat !== 'number') throw new Error(`bigbasket place lookup failed: HTTP ${det.status}`);

  // The place's centre can fall just outside BigBasket's quick-delivery zone even when most of the
  // pincode is inside it (140603: the Azizpur centre is out, Zirakpur is in). Try that point, then
  // points spread across the pincode, and use the first one with a store that delivers (bbnow is
  // the 10 minute service, bb-daily the scheduled one).
  const points = [{ lat: loc.lat as number, lng: loc.lng as number }, ...candidatePoints(pincode).slice(0, 12)];
  let chosen: { lat: number; lng: number } | null = null;
  for (const p of points) {
    const sv = await call(page, `/ui-svc/v1/serviceable/?lat=${p.lat}&lng=${p.lng}&send_all_serviceability=true`);
    if (sv.status !== 200 && sv.status !== 303) throw new Error(`bigbasket serviceability check failed: HTTP ${sv.status}`);
    const services = Object.keys(sv.body?.serviceable_ecs_info ?? {});
    if (sv.status === 200 && (services.includes('bbnow') || services.includes('bb-daily'))) {
      chosen = p;
      break;
    }
    await page.waitForTimeout(300);
  }
  if (!chosen) throw new NotServiceableError(`bigbasket has no delivering store anywhere in ${pincode}`);

  // State-changing calls need the site's CSRF token (header copy of the csurftoken cookie)
  // and the same channel headers its own web app sends.
  const csurf = (await page.context().cookies(ORIGIN)).find((c) => c.name === 'csurftoken')?.value;
  if (!csurf) throw new Error('bigbasket: no csurftoken cookie (bot check not passed or layout change)');
  const put = await call(page, '/member-svc/v2/member/current-delivery-address/', {
    method: 'PUT',
    body: { lat: chosen.lat, long: chosen.lng, return_hub_cookies: false, area: null, contact_zipcode: pincode },
    headers: {
      'x-csurftoken': csurf,
      'x-channel': 'BB-WEB',
      'x-caller': 'UI-KIRK',
      'x-entry-context': 'bbnow',
      'x-entry-context-id': '10',
      'x-requested-with': 'XMLHttpRequest',
      'x-tracker': crypto.randomUUID(),
      'common-client-static-version': '101',
      'x-integrated-fc-door-visible': 'false',
    },
  });
  if (put.status !== 200) throw new Error(`bigbasket could not set the delivery address: HTTP ${put.status}`);

  // The store (serviceable area) cookies are issued when the page loads with the new address.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);

  const cookies = await page.context().cookies(ORIGIN);
  // BigBasket records the pincode of its own address lookup for the point, which for a border
  // point can be the neighbouring pincode; any value means the location was accepted.
  if (!cookies.find((c) => c.name === '_bb_pin_code')?.value) {
    throw new Error(`bigbasket did not accept a delivery location for ${pincode} (location cookie not set)`);
  }
}

function toListing(p: any): RawListing | null {
  const id = String(p?.id ?? '');
  const title = String(p?.desc ?? '').trim();
  const brand: string | null = p?.brand?.name ?? null;
  const d = p?.pricing?.discount;
  const price = Number(d?.prim_price?.sp);
  if (!id || !title || !Number.isFinite(price) || price <= 0) return null;
  const mrp = Number(d?.mrp);
  const a = p?.availability;
  // avail_status "001" is "available"; not_for_sale and other codes mean it cannot be bought here now.
  const inStock = a?.avail_status === '001' && a?.not_for_sale !== true;
  return {
    platformProductId: id,
    title,
    brand,
    price,
    mrp: Number.isFinite(mrp) && mrp >= price ? mrp : null,
    inStock,
    url: p?.absolute_url ? `${ORIGIN}${p.absolute_url}` : `${ORIGIN}/pd/${id}/`,
  };
}

export const bigbasket: Adapter = {
  id: 'bigbasket',
  name: 'BigBasket',
  locationKey: 'pincode',
  minIntervalMin: 15,

  async fetchLegoListings(pin: Pincode): Promise<RawListing[]> {
    const ctx = await newContext();
    try {
      const page = await ctx.newPage();
      // Load the home page first so the bot-detection script sets its cookies before any API call.
      const nav = await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (nav && nav.status() >= 400) throw new Error(`bigbasket home returned HTTP ${nav.status()}`);
      await page.waitForTimeout(4500);

      await setPincode(page, pin.pincode);

      // The search page picks the right store bucket itself; capture its first listing call
      // and reuse that exact URL for further pages.
      const first = page.waitForResponse((r) => r.url().includes('/listing-svc/v2/products'), { timeout: 45000 });
      await page.goto(`${ORIGIN}/ps/?q=lego`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const firstRes = await first;
      if (!firstRes.ok()) throw new Error(`bigbasket listing returned HTTP ${firstRes.status()}`);
      const template = firstRes.url();
      let json: any = await firstRes.json();

      const byId = new Map<string, RawListing>();
      const add = (j: any) => {
        for (const p of j?.tabs?.[0]?.product_info?.products ?? []) {
          // The search also returns other brands (building blocks etc.); only LEGO is wanted.
          if (!/^lego$/i.test(String(p?.brand?.name ?? '').trim())) continue;
          const l = toListing(p);
          if (l) byId.set(l.platformProductId, l);
        }
      };
      add(json);

      const info = json?.tabs?.[0]?.product_info;
      const pages = Math.min(Number(info?.number_of_pages ?? 1), MAX_PAGES);
      const reportedTotal = Number(info?.total_count ?? 0);
      let pagesRead = 1;
      for (let n = 2; n <= pages; n++) {
        await page.waitForTimeout(PAGE_DELAY_MS);
        const u = new URL(template);
        u.searchParams.set('page', String(n));
        const res = await call(page, u.toString());
        // The page count is an estimate; BigBasket answers 204 (no content) past the real last page.
        if (res.status === 204) {
          pagesRead = pages;
          break;
        }
        if (res.status !== 200 || !res.body) throw new Error(`bigbasket listing page ${n} failed: HTTP ${res.status}`);
        add(res.body);
        pagesRead++;
      }
      if (Number(info?.number_of_pages ?? 1) > MAX_PAGES) {
        throw new Error(`bigbasket search has more than ${MAX_PAGES} pages; layout change?`);
      }
      // Sanity check against the site's own page count so a silent partial read is never
      // reported as complete (the total includes other brands, so only compare pages read).
      if (reportedTotal > 0 && pagesRead < pages) {
        throw new Error(`bigbasket: read ${pagesRead} of ${pages} result pages`);
      }
      return [...byId.values()];
    } finally {
      await ctx.close();
    }
  },
};
