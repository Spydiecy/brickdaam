import type { Page } from 'playwright';
import { db } from '../db.js';
import { NotServiceableError, type Adapter, type Pincode, type RawListing } from '../types.js';
import { newContext } from '../browser.js';
import { isLego } from '../match.js';
import { setPincode } from './flipkart.js';

/**
 * Flipkart Minutes is Flipkart's quick-commerce store (marketplace=HYPERLOCAL on flipkart.com).
 * The delivery pincode picks the micro-fulfilment centre, and the product links carry its shopId.
 *
 * COVERAGE IS PARTIAL BY NATURE. A Minutes search renders exactly 8 products with no paging, scrolling
 * or "view all" (the page is one screen tall and fires no further requests). To get most of the range
 * we union many searches:
 *   1. the plain "lego" query,
 *   2. "lego <theme>" for the biggest LEGO themes in the catalog, and
 *   3. "lego <set number>" for sets that another quick-commerce app currently has in stock.
 * Sets that no theme or set-number query surfaces can still be missed.
 */
const ORIGIN = 'https://www.flipkart.com';
const MAX_THEMES = 25;
const MAX_SET_QUERIES = 120;
const QUERY_DELAY_MS = 600;
const PINCODE_ATTEMPTS = 3;
const EXCLUDED_THEMES = new Set([
  'Gear', 'Other', 'Promotional', 'Seasonal', 'Editions', 'Xtra', 'LEGO Exclusive', 'Legoland Parks',
  'LEGO Brand Store', 'BrickLink Designer Program', 'Educational and Dacta', 'FIRST LEGO League', 'Power Functions',
]);
const OTHER_QUICK_COMMERCE = ['blinkit', 'zepto', 'ozi', 'bigbasket', 'instamart'];

function buildQueries(): string[] {
  const themes = (
    db
      .prepare(`SELECT theme FROM sets WHERE year >= 2020 AND theme <> '' GROUP BY theme ORDER BY COUNT(*) DESC LIMIT ?`)
      .all(MAX_THEMES + EXCLUDED_THEMES.size) as { theme: string }[]
  )
    .map((r) => r.theme)
    .filter((t) => !EXCLUDED_THEMES.has(t))
    .slice(0, MAX_THEMES);

  const marks = OTHER_QUICK_COMMERCE.map(() => '?').join(',');
  const setNumbers = (
    db
      .prepare(
        `SELECT DISTINCT l.set_number AS n
         FROM listings l JOIN prices p ON p.listing_id = l.id
          AND p.id = (SELECT MAX(id) FROM prices WHERE listing_id = l.id AND pincode = p.pincode)
         WHERE p.in_stock = 1 AND l.platform IN (${marks})
         ORDER BY l.set_number LIMIT ?`,
      )
      .all(...OTHER_QUICK_COMMERCE, MAX_SET_QUERIES) as { n: string }[]
  ).map((r) => r.n);

  return ['lego', ...themes.map((t) => `lego ${t}`), ...setNumbers.map((n) => `lego ${n}`)];
}

interface MinutesCard {
  pid: string;
  href: string;
  title: string;
  leaves: string[];
}

function readCards(page: Page): Promise<MinutesCard[]> {
  return page.evaluate(() => {
    const out: MinutesCard[] = [];
    const seen = new Set<string>();
    for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href*="/p/itm"]')) {
      const pid = new URL(a.href).searchParams.get('pid');
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      let el: HTMLElement | null = a;
      for (let i = 0; i < 8 && el && !/₹\d/.test(el.innerText); i++) el = el.parentElement;
      out.push({
        pid,
        href: a.href,
        // Minutes cards carry no title attribute; the product name is the anchor's first line.
        title: (a.getAttribute('title') || a.innerText.split('\n')[0] || '').trim(),
        leaves: [...(el?.querySelectorAll('*') ?? [])]
          .filter((e) => e.children.length === 0)
          .map((e) => (e.textContent || '').trim())
          .filter(Boolean),
      });
    }
    return out;
  });
}

function toListing(c: MinutesCard): RawListing | null {
  // Leaves read like: "50%", "Off", <title>, "12 mins", "₹899" (MRP), "₹449" (price), "Add".
  const title = c.title || c.leaves.find((t) => /lego/i.test(t) && t.length > 12) || '';
  const rupees = c.leaves.filter((t) => /^₹[\d,]+$/.test(t)).map((t) => Number(t.replace(/[₹,]/g, '')));
  if (!title || rupees.length === 0) return null;
  // Struck-through MRP comes first when there is a discount; a single value is just the price.
  const [first, second] = rupees;
  const price = second != null && second <= first ? second : first;
  const mrp = second != null && first >= second ? first : null;
  const eta = c.leaves.find((t) => /^\d+\s*mins?$/i.test(t));
  // Cards without an "Add" button are not purchasable right now.
  const inStock = c.leaves.some((t) => /^add$/i.test(t));
  void eta;
  return {
    platformProductId: c.pid,
    title,
    // Minutes search is not brand-filtered, so only a title that starts with LEGO counts as the brand.
    brand: /^\s*lego\b/i.test(title) ? 'LEGO' : null,
    price,
    mrp: mrp != null && mrp > price ? mrp : null,
    inStock,
    // Keep the dark-store parameters so the link opens the same Minutes listing and price.
    url: c.href.replace(/&lid=[^&]*/, ''),
  };
}

export const flipkartMinutes: Adapter = {
  id: 'flipkart-minutes',
  name: 'Flipkart Minutes',
  locationKey: 'pincode',
  // A crawl is a few hundred searches, so it runs on the slow lane rather than every 5 minutes.
  minIntervalMin: 30,

  async fetchLegoListings(pin: Pincode): Promise<RawListing[]> {
    const ctx = await newContext();
    try {
      let page = await ctx.newPage();
      for (let attempt = 1; ; attempt++) {
        try {
          await setPincode(page, pin.pincode);
          break;
        } catch (err) {
          if (attempt >= PINCODE_ATTEMPTS) throw err;
          await page.close().catch(() => {});
          page = await ctx.newPage();
          await page.waitForTimeout(2000);
        }
      }

      const byPid = new Map<string, RawListing>();
      let emptyRun = 0;
      let first = true;
      let noNewRun = 0;
      for (const q of buildQueries()) {
        // Later queries mostly re-find known items; stop once 25 in a row add nothing new.
        if (noNewRun >= 25) break;
        const before = byPid.size;
        await page.goto(`${ORIGIN}/search?q=${encodeURIComponent(q)}&marketplace=HYPERLOCAL`, {
          waitUntil: 'domcontentloaded',
          timeout: 45000,
        });
        const body = await page.locator('body').innerText().catch(() => '');
        if (/are you a human|unusual traffic|captcha/i.test(body.slice(0, 600))) {
          throw new Error('flipkart minutes is showing a bot check; backing off');
        }
        await page.waitForSelector('a[href*="/p/itm"]', { timeout: first ? 15000 : 6000 }).catch(() => {});
        await page.waitForTimeout(700);
        const cards = await readCards(page);

        if (first && cards.length === 0) {
          // An empty first search is either "no Minutes store here" or a page that had not settled.
          // Retry once, then ask the Minutes store page: it shows a delivery ETA only when served.
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForSelector('a[href*="/p/itm"]', { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(1000);
          cards.push(...(await readCards(page)));
          if (cards.length === 0) {
            await page.goto(`${ORIGIN}/or/flipkart-minutes-store`, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForTimeout(5000);
            const store = await page.locator('body').innerText().catch(() => '');
            if (!/\b\d+\s*mins?\b/i.test(store.slice(0, 400))) {
              throw new NotServiceableError(`flipkart minutes does not deliver to ${pin.pincode}`);
            }
            throw new Error('flipkart minutes: the store serves this pincode but the LEGO search came back empty');
          }
        }
        first = false;
        emptyRun = cards.length === 0 ? emptyRun + 1 : 0;
        if (emptyRun >= 8) throw new Error('flipkart minutes: eight searches in a row returned nothing (block or layout change)');

        for (const c of cards) {
          if (!isLego({ title: c.title, brand: /^\s*lego\b/i.test(c.title) ? 'LEGO' : null })) continue; // other brands appear in searches
          const l = toListing(c);
          if (l) byPid.set(l.platformProductId, l);
        }
        noNewRun = byPid.size > before ? 0 : noNewRun + 1;
        await page.waitForTimeout(QUERY_DELAY_MS);
      }
      return [...byPid.values()];
    } finally {
      await ctx.close();
    }
  },
};
