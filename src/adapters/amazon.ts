import type { Page } from 'playwright';
import { NotServiceableError, type Adapter, type Pincode, type RawListing } from '../types.js';
import { newContext } from '../browser.js';

const PAGE_DELAY_MS = 1200;
const MAX_PAGES_PER_BAND = 8;
// amazon.in serves at most ~300 results (7 pages of 48) for any single query, however many it
// says exist ("over 2,000 results"). A price band with at most this many results can be read
// completely; a bigger band is split in two.
const BAND_CAP = 280;
const TABS = 3; // search pages read at the same time
const MAX_REQUESTS = 120; // hard ceiling on search pages per crawl
const START_BANDS: [number, number | null][] = [
  [0, 400], [400, 800], [800, 1200], [1200, 1800], [1800, 2500], [2500, 4000],
  [4000, 7000], [7000, 12000], [12000, 20000], [20000, null],
];

const rupees = (t: string | null | undefined): number | null => {
  const m = (t ?? '').replace(/,/g, '').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

async function assertNoCaptcha(page: Page) {
  const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  if (/enter the characters you see below|type the characters|not a robot/i.test(body)) {
    throw new Error('amazon is showing a captcha; backing off');
  }
}

/** Resolve once the main frame has not navigated for `quietMs` (or after `maxMs`). */
async function waitForNavigationsToSettle(page: Page, quietMs = 2500, maxMs = 15000) {
  let last = Date.now();
  const onNav = (f: { parentFrame(): unknown }) => {
    if (!f.parentFrame()) last = Date.now();
  };
  page.on('framenavigated', onNav);
  try {
    const deadline = Date.now() + maxMs;
    while (Date.now() - last < quietMs && Date.now() < deadline) await page.waitForTimeout(250);
  } finally {
    page.off('framenavigated', onNav);
  }
}

/**
 * Open the "Update location" popover on the amazon.in home page.
 *
 * Root cause of the intermittent "#GLUXZipUpdateInput not visible" failure (reproduced with
 * several parallel contexts, 7 of 12 naive runs failed): amazon.in answers `/` with an HTTP 202
 * shell page whose script reloads the document about 0.8s later, and under load it reloads a
 * second time about 0.8s after that (three main-frame navigations in total). The location link
 * exists in the second document, so Playwright's auto-waiting click succeeded, but the third
 * document then replaced the page and threw the just-opened popover away, so the zip input never
 * became visible. Occasionally an interstitial with a "continue shopping" button is served instead
 * of the site. Fix: wait for the real navbar, dismiss the interstitial, wait until the main frame
 * has stopped navigating, then click, and retry the whole sequence a few times.
 */
async function openLocationPopover(page: Page) {
  const input = page.locator('#GLUXZipUpdateInput');
  let lastErr = 'unknown';
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await page.goto('https://www.amazon.in/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await assertNoCaptcha(page);

      // Wait for the real navbar; click through the "continue shopping" interstitial if shown.
      const link = page.locator('#nav-global-location-popover-link');
      const cont = page.getByRole('button', { name: /continue shopping/i });
      const deadline = Date.now() + 20000;
      while (!(await link.isVisible().catch(() => false))) {
        if (Date.now() > deadline) throw new Error('navbar never appeared');
        if (await cont.first().isVisible().catch(() => false)) {
          await cont.first().click().catch(() => {});
          await page.waitForTimeout(1500);
        }
        await page.waitForTimeout(300);
      }
      await assertNoCaptcha(page);

      // The navbar can appear on a document that is about to be replaced again. Wait until the
      // main frame has not navigated for a while, and the navbar is still there, before clicking.
      await waitForNavigationsToSettle(page);
      await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      if (!(await link.isVisible().catch(() => false))) throw new Error('navbar vanished after settling');

      // Click, and if the popover does not open, click again before giving up on this load.
      for (let click = 0; click < 3; click++) {
        await link.click({ timeout: 8000 });
        if (await input.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) return;
      }
      throw new Error('#GLUXZipUpdateInput not visible after clicking the location link');
    } catch (err) {
      lastErr = (err as Error).message.split('\n')[0];
      if (/captcha/i.test(lastErr)) throw err;
      await page.waitForTimeout(1500 * attempt);
    }
  }
  throw new Error(`amazon: could not open the location popover (${lastErr})`);
}

/** Set the delivery pincode the way a shopper does, then confirm Amazon accepted it. */
export async function setPincode(page: Page, pincode: string) {
  let lastErr = 'unknown';
  for (let attempt = 1; attempt <= 3; attempt++) {
    await openLocationPopover(page);
    const input = page.locator('#GLUXZipUpdateInput');

    // The Apply button posts to /glow/address-change. If the popover was re-rendered under us,
    // Amazon's script shows "Please enter a valid pincode" without sending anything; that is a
    // client-side glitch, not a verdict on the pincode, so we reopen and try again.
    // The input becomes visible about 1.5s before Amazon's handler for Apply is bound (measured:
    // submitting immediately failed 4 of 8 times, after a 1.5s pause 0 of 8), so pause first.
    await page.waitForTimeout(1500);
    let res = null;
    for (let tries = 0; tries < 3 && !res; tries++) {
      const reply = page
        .waitForResponse((r) => r.url().includes('/glow/address-change') && r.request().method() === 'POST', { timeout: 8000 })
        .catch(() => null);
      try {
        await input.fill(pincode, { timeout: 5000 });
        if ((await input.inputValue()) !== pincode) throw new Error('zip input did not keep the value');
        await page.click('#GLUXZipUpdate input, #GLUXZipUpdate', { timeout: 5000 });
      } catch (err) {
        lastErr = (err as Error).message.split('\n')[0];
        break;
      }
      res = await reply;
      if (!res) {
        const shown = await page.locator('#GLUXZipError, #GLUXZipInlineError').first().innerText({ timeout: 1000 }).catch(() => '');
        lastErr = `no address-change request was sent${shown ? ` (${shown.trim()})` : ''}`;
        await page.waitForTimeout(1500);
      }
    }
    if (!res) continue;
    if (!res.ok()) throw new Error(`amazon address-change returned HTTP ${res.status()}`);
    const body = (await res.json().catch(() => null)) as { isValidAddress?: number; successful?: number; address?: { zipCode?: string } } | null;
    if (!body) throw new Error('amazon address-change returned an unreadable body (layout change?)');
    if (!body.successful || !body.isValidAddress) {
      throw new NotServiceableError(`amazon rejected pincode ${pincode}`);
    }

    // Success reloads the page. Confirm the navbar now shows this pincode, the way a shopper would.
    const label = page.locator('#glow-ingress-block');
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const text = (await label.innerText({ timeout: 2000 }).catch(() => '')).replace(/\s+/g, ' ');
      if (text.includes(pincode)) return;
      await page.waitForTimeout(500);
    }
    throw new Error(`amazon accepted pincode ${pincode} but the navbar never showed it`);
  }
  throw new Error(`amazon: could not apply pincode ${pincode} (${lastErr})`);
}

interface Card {
  asin: string;
  title: string;
  slug: string | null;
  brand: string | null;
  price: string | null;
  mrp: string | null;
  blocked: boolean;
}

/** Title for a card. A few sellers list a product as just "New"; the product URL slug then carries the real name. */
function cardTitle(c: Card): string {
  const title = c.title.trim();
  const slugText = c.slug ? c.slug.replace(/-/g, ' ').trim() : '';
  if (title.split(/\s+/).length <= 3 && slugText.split(/\s+/).length > title.split(/\s+/).length) {
    const nums = slugText.match(/(?<!\d)\d{4,6}(?!\d)/g) ?? [];
    if (nums.some((n) => !title.includes(n))) return slugText;
  }
  return title;
}

/** Result count shown above a search: a number, Infinity for "over N", 0 for none, null if not found. */
async function resultCount(page: Page): Promise<number | null> {
  const text = await page
    .locator('[data-component-type="s-result-info-bar"]')
    .first()
    .innerText({ timeout: 4000 })
    .catch(() => '');
  const flat = text.replace(/\s+/g, ' ');
  const over = flat.match(/of over ([\d,]+) results/i);
  if (over) return Infinity;
  const m = flat.match(/(?:of\s+)?([\d,]+) results? for/i);
  if (m) return Number(m[1].replace(/,/g, ''));
  if (/no results for/i.test(flat)) return 0;
  return null;
}

const bandUrl = (lo: number, hi: number | null, page: number) =>
  `https://www.amazon.in/s?k=lego&rh=p_89%3ALEGO&low-price=${lo}&high-price=${hi ?? ''}&page=${page}`;

export const amazon: Adapter = {
  id: 'amazon',
  name: 'Amazon.in',
  locationKey: 'pincode',
  minIntervalMin: 30,

  async fetchLegoListings(pin: Pincode): Promise<RawListing[]> {
    const ctx = await newContext();
    try {
      const first = await ctx.newPage();
      await setPincode(first, pin.pincode);

      const byAsin = new Map<string, RawListing>();
      let requests = 0;

      /** Load one results page and add its cards. Returns cards seen and whether there is a next page. */
      const readPage = async (page: Page, lo: number, hi: number | null, n: number) => {
        if (++requests > MAX_REQUESTS) throw new Error('amazon: too many search pages in one crawl, aborting');
        await page.goto(bandUrl(lo, hi, n), { waitUntil: 'domcontentloaded', timeout: 45000 });
        await assertNoCaptcha(page);
        await page
          .waitForSelector('[data-component-type="s-search-result"], [data-component-type="s-result-info-bar"]', {
            timeout: 20000,
          })
          .catch(() => {});

        const cards: Card[] = await page.$$eval('[data-component-type="s-search-result"]', (els) =>
          els.map((e) => {
            const h2 = e.querySelector('h2.a-text-normal') ?? e.querySelector('h2:not(.s-line-clamp-1)');
            const href = (e.querySelector('h2 a, a.s-link-style') as HTMLAnchorElement | null)?.getAttribute('href') ?? '';
            return {
              asin: e.getAttribute('data-asin') ?? '',
              title: h2?.getAttribute('aria-label') ?? h2?.textContent ?? e.querySelector('img.s-image')?.getAttribute('alt') ?? '',
              slug: href.match(/^\/([^/]+)\/dp\//)?.[1] ?? null,
              brand: e.querySelector('h2.s-line-clamp-1')?.textContent?.trim() ?? null,
              price: e.querySelector('.a-price:not(.a-text-price) .a-offscreen')?.textContent ?? null,
              mrp: e.querySelector('.a-price.a-text-price .a-offscreen')?.textContent ?? null,
              blocked: /currently unavailable|cannot be shipped|not deliverable|no featured offers/i.test(e.textContent ?? ''),
            };
          }),
        );
        for (const c of cards) {
          const price = rupees(c.price);
          const title = cardTitle(c);
          if (!c.asin || !title || price == null || byAsin.has(c.asin)) continue;
          // The brand filter is in the URL, but ads and look-alike sellers can slip in; the brand
          // shown on the card must be exactly LEGO (checked again, with title rules, in the pipeline).
          if (c.brand && c.brand.replace(/[^\p{L}]/gu, '').toLowerCase() !== 'lego') continue;
          byAsin.set(c.asin, {
            platformProductId: c.asin,
            title,
            brand: c.brand,
            price,
            mrp: rupees(c.mrp),
            inStock: !c.blocked,
            url: `https://www.amazon.in/dp/${c.asin}`,
          });
        }
        const hasNext = (await page.locator('a.s-pagination-next:not(.s-pagination-disabled)').count()) > 0;
        return { cards: cards.length, hasNext };
      };

      /** Read one price band completely, splitting it first if it has more results than Amazon will page through. */
      const crawlBand = async (page: Page, lo: number, hi: number | null): Promise<void> => {
        const first = await readPage(page, lo, hi, 1);
        const total = await resultCount(page);
        if (total === null && first.cards > 0) throw new Error('amazon: result count not found on the page (layout change?)');

        if (total !== null && total > BAND_CAP) {
          const mid = hi === null ? lo * 2 : Math.floor((lo + hi) / 2);
          if (mid > lo && (hi === null || mid < hi) && mid <= 2_000_000) {
            await page.waitForTimeout(PAGE_DELAY_MS);
            await crawlBand(page, lo, mid);
            await page.waitForTimeout(PAGE_DELAY_MS);
            await crawlBand(page, mid, hi);
            return;
          }
        }
        let { hasNext } = first;
        for (let n = 2; hasNext && n <= MAX_PAGES_PER_BAND; n++) {
          await page.waitForTimeout(PAGE_DELAY_MS);
          const r = await readPage(page, lo, hi, n);
          if (r.cards === 0) break;
          hasNext = r.hasNext;
        }
      };

      // Price bands are independent, so read them in a few tabs at once. The delivery pincode is
      // stored in the browser context's cookies, so every tab sees the same location.
      const queue = [...START_BANDS];
      const pages = [first, ...(await Promise.all(Array.from({ length: TABS - 1 }, () => ctx.newPage())))];
      await Promise.all(
        pages.map(async (page, i) => {
          await page.waitForTimeout(i * 700);
          for (let band = queue.shift(); band; band = queue.shift()) {
            await crawlBand(page, band[0], band[1]);
            await page.waitForTimeout(PAGE_DELAY_MS);
          }
        }),
      );
      if (byAsin.size === 0) throw new Error('amazon: no LEGO results parsed at all (block or layout change?)');
      return [...byAsin.values()];
    } finally {
      await ctx.close();
    }
  },
};
