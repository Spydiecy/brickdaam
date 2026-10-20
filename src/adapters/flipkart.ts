import type { Page } from 'playwright';
import { NotServiceableError, type Adapter, type Pincode, type RawListing } from '../types.js';
import { newContext } from '../browser.js';

const ORIGIN = 'https://www.flipkart.com';
// Search "lego", filtered to the LEGO brand so other brands' sets are not read.
const SEARCH = `${ORIGIN}/search?q=lego&p%5B%5D=facets.brand%255B%255D%3DLEGO`;
const MAX_PAGES = 30;
const PAGE_DELAY_MS = 1500;
const MIN_FILLED = 0.85;
const SORTS = ['', 'price_asc', 'price_desc'];
const PINCODE_ATTEMPTS = 3;
const MIN_UNION_OF_TOTAL = 0.85;

interface ParsedCard {
  pid: string;
  title: string;
  href: string;
  price: number | null;
  mrp: number | null;
  text: string;
}

/**
 * Flipkart renders results server side but lazily mounts cards as they scroll into view.
 * Scroll through the page and keep going until every announced card has mounted with a price
 * (or the page stops changing for a few checks in a row).
 */
async function loadAllCards(page: Page, expectedSlots: number | null): Promise<ParsedCard[]> {
  // A page can show the same product in more than one slot (sponsored placements), so distinct
  // products are slightly fewer than announced slots. Treat >= 85% as "filled".
  const filled = expectedSlots == null ? 1 : Math.ceil(expectedSlots * MIN_FILLED);
  let best: ParsedCard[] = [];
  let stable = 0;
  for (let i = 0; i < 30; i++) {
    const cards = (await parseCards(page)).filter((c) => c.title && c.price != null);
    if (cards.length > best.length) {
      best = cards;
      stable = 0;
    } else {
      stable++;
    }
    if (best.length >= filled && stable >= 3) break; // enough cards, and nothing new is appearing
    if (stable >= 10) break; // gave up waiting; the caller decides whether it is short
    await page.mouse.wheel(0, i % 6 === 5 ? -4000 : 1800); // occasionally scroll back up to re-trigger mounting
    await page.waitForTimeout(450);
  }
  return best;
}

function parseCards(page: Page): Promise<ParsedCard[]> {
  return page.evaluate(() => {
    const byPid = new Map<string, HTMLAnchorElement[]>();
    for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href*="/p/itm"]')) {
      const pid = new URL(a.href).searchParams.get('pid');
      if (!pid) continue;
      byPid.set(pid, [...(byPid.get(pid) ?? []), a]);
    }
    return [...byPid.entries()].map(([pid, anchors]) => {
      const a = anchors.find((x) => x.getAttribute('title')) ?? anchors[0];
      // the card is the nearest ancestor that already contains a rupee price
      let card: HTMLElement | null = a;
      for (let i = 0; i < 7 && card && !/₹\d/.test(card.innerText || ''); i++) card = card.parentElement;
      const leaves = [...(card?.querySelectorAll('*') ?? [])]
        .filter((e) => e.children.length === 0)
        .map((e) => (e.textContent || '').trim())
        .filter(Boolean);
      const rupees = leaves.filter((t) => /^₹[\d,]+$/.test(t)).map((t) => Number(t.replace(/[₹,]/g, '')));
      return {
        pid,
        title: a.getAttribute('title') ?? '',
        href: a.getAttribute('href') ?? '',
        price: rupees[0] ?? null,
        mrp: rupees[1] ?? null,
        text: (card?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300),
      };
    });
  });
}

/**
 * Set the delivery pincode the way a shopper does: open the address picker on a product page,
 * search the pincode, pick the suggestion and confirm. Flipkart stores it in localStorage
 * (`mypin`) and an encrypted `ud` cookie, which the rest of the session then uses.
 */
export async function setPincode(page: Page, pincode: string): Promise<void> {
  await page.goto(`${ORIGIN}/search?q=lego`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('a[href*="/p/itm"]', { timeout: 20000 });
  const productUrl = await page.$eval('a[href*="/p/itm"]', (a) => (a as HTMLAnchorElement).href);
  await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // Clicking before the page has hydrated does nothing, so retry until the panel actually opens.
  const trigger = page.getByText('Select delivery location', { exact: true }).first();
  const box = page.locator('input[placeholder*="Search by area"]').first();
  await trigger.waitFor({ timeout: 20000 });
  let opened = false;
  for (let attempt = 0; attempt < 5 && !opened; attempt++) {
    await page.waitForTimeout(2500);
    await trigger.click({ timeout: 8000 }).catch(() => {});
    opened = await box.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false);
  }
  if (!opened) throw new Error('flipkart: the delivery location panel did not open (layout change?)');
  // Suggestions come from a Google Places script that loads lazily and re-renders as it answers.
  // Some pincodes get a single suggestion (e.g. 140603 -> "Azizpur, Punjab 140603"), others several.
  // Type the pincode, wait until the list stops changing, click the first suggestion, and expect the
  // picker to move on to its "Confirm" step. If anything in that chain fails, clear and try again.
  const rows = page.getByText(new RegExp(`\\b${pincode}\\b`));
  const confirm = page.getByText(/^confirm/i).first();
  let confirmed = false;
  let sawSuggestions = false;
  for (let attempt = 0; attempt < 4 && !confirmed; attempt++) {
    await box.fill('');
    await box.click();
    await page.keyboard.type(pincode, { delay: 100 });

    let last = -1;
    let steady = 0;
    for (let i = 0; i < 24 && steady < 3; i++) {
      await page.waitForTimeout(500);
      const n = await rows.count();
      steady = n >= 1 && n === last ? steady + 1 : 0;
      last = n;
    }
    if (last < 1) continue; // no suggestions yet: the Places script was probably not ready
    sawSuggestions = true;

    await rows.first().click({ timeout: 5000 }).catch(() => {});
    confirmed = await confirm.waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false);
  }
  if (!sawSuggestions) throw new NotServiceableError(`flipkart found no place for pincode ${pincode}`);
  if (!confirmed) throw new Error(`flipkart: the delivery picker did not reach its confirm step for ${pincode}`);
  await confirm.click({ timeout: 10000 });
  await page.waitForTimeout(3000);

  const stored = await page.evaluate(() => localStorage.getItem('mypin'));
  if (stored !== pincode) {
    throw new NotServiceableError(`flipkart did not accept pincode ${pincode} (stored: ${stored ?? 'none'})`);
  }
}

const slugUrl = (href: string, pid: string) => {
  const path = href.split('?')[0];
  return `${ORIGIN}${path}?pid=${pid}`;
};

export const flipkart: Adapter = {
  id: 'flipkart',
  name: 'Flipkart',
  locationKey: 'pincode',
  minIntervalMin: 30,

  async fetchLegoListings(pin: Pincode): Promise<RawListing[]> {
    // Flipkart bounces product pages to its homepage for datacenter IPs. FLIPKART_PROXY points at the
    // free local WARP proxy set up by deploy/warp.sh; unset on a home or office connection.
    const ctx = await newContext({ proxy: process.env.FLIPKART_PROXY });
    try {
      // The address picker depends on a lazily loaded Google Places script and occasionally fails to
      // produce suggestions, so retry the whole step on a fresh page before giving up.
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

      // One sort order alone silently misses about a quarter of the range (sponsored placements
      // reshuffle which products land on which page), but the union of relevance, price ascending
      // and price descending reaches the site's own total. Read all three and merge.
      const byPid = new Map<string, RawListing>();
      let reportedTotal: number | null = null;
      // The three sort orders are independent: read them in separate tabs at once. The delivery
      // pincode lives in the context's cookies and storage, so each tab sees the same location.
      const tabs = [page, ...(await Promise.all(SORTS.slice(1).map(() => ctx.newPage())))];
      const results = await Promise.allSettled(
        SORTS.map(async (sort, i) => {
          await tabs[i].waitForTimeout(i * 800);
          return (await crawlSort(tabs[i], sort, byPid)).total;
        }),
      );
      const ok = results.filter((r): r is PromiseFulfilledResult<number | null> => r.status === 'fulfilled');
      // One sort order cut short (a page that would not render) is fine as long as the others got
      // through: the union check below still guards against a partial picture.
      if (ok.length === 0) throw (results[0] as PromiseRejectedResult).reason;
      for (const r of ok) reportedTotal = Math.max(reportedTotal ?? 0, r.value ?? 0) || reportedTotal;

      if (byPid.size === 0) throw new Error('flipkart returned no LEGO products (layout change or block)');
      // The reported total counts repeated sponsored slots, so allow some slack, but a union far
      // below it means pages went missing and must not be stored as a complete picture.
      if (reportedTotal != null && byPid.size < reportedTotal * MIN_UNION_OF_TOTAL) {
        throw new Error(`flipkart: found ${byPid.size} products but the site reports ${reportedTotal} results`);
      }
      return [...byPid.values()];
    } finally {
      await ctx.close();
    }
  },
};

/** Read every result page of one sort order into `into`. Throws if the crawl did not reach the last page. */
async function crawlSort(
  page: Page,
  sort: string,
  into: Map<string, RawListing>,
): Promise<{ total: number | null }> {
  let total: number | null = null;
  let reachedEnd = false;
  for (let n = 1; n <= MAX_PAGES; n++) {
    if (n > 1) await page.waitForTimeout(PAGE_DELAY_MS);
    await page.goto(`${SEARCH}${sort ? `&sort=${sort}` : ''}&page=${n}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await page.waitForSelector('a[href*="/p/itm"]', { timeout: 20000 }).catch(() => {});
    const body = await page.locator('body').innerText();
    if (/are you a human|unusual traffic|captcha/i.test(body.slice(0, 600))) {
      throw new Error('flipkart is showing a bot check; backing off');
    }
    const header = body.match(/Showing\s+(\d+)\s*[–-]\s*(\d+)\s+of\s+([\d,]+)\s+results/i);
    if (header) total = Number(header[3].replace(/,/g, ''));

    // Each page announces how many cards it holds ("Showing 41 – 80 of N").
    const slots = header ? Number(header[2]) - Number(header[1]) + 1 : null;
    let cards = await loadAllCards(page, slots);
    // Flipkart occasionally serves an empty page in the middle of the results. Before the last
    // page, reload it once rather than treating it as the end.
    // An empty page mid-results is Flipkart slowing us down; back off progressively (3s, 8s, 15s).
    for (let retry = 1; cards.length === 0 && retry <= 3 && (total == null || (n - 1) * 40 < total); retry++) {
      await page.waitForTimeout([3000, 8000, 15000][retry - 1]);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector('a[href*="/p/itm"]', { timeout: 20000 }).catch(() => {});
      cards = await loadAllCards(page, slots);
    }
    if (process.env.DEBUG_FLIPKART) {
      console.log(`[flipkart] sort=${sort || 'relevance'} page ${n}: ${header?.[0]} cards=${cards.length}/${slots}`);
    }
    if (cards.length === 0) break;
    // A page that shows fewer cards than it announces was not fully read.
    if (slots != null && cards.length < Math.ceil(slots * MIN_FILLED)) {
      throw new Error(`flipkart page ${n} showed ${cards.length} of ${slots} cards (lazy rendering did not finish)`);
    }
    for (const c of cards) {
      const unavailable = /sold out|currently unavailable|out of stock|not deliverable|coming soon/i.test(c.text);
      into.set(c.pid, {
        platformProductId: c.pid,
        title: c.title,
        // The search is filtered to Flipkart's own LEGO brand facet, so the brand comes from that filter,
        // not from guessing at the title. Imitations still get rejected by the shared title rules.
        brand: 'LEGO',
        price: c.price!,
        mrp: c.mrp != null && c.price != null && c.mrp >= c.price ? c.mrp : null,
        inStock: !unavailable,
        url: slugUrl(c.href, c.pid),
      });
    }
    if (header && Number(header[2]) >= Number(header[3].replace(/,/g, ''))) {
      reachedEnd = true;
      break;
    }
  }
  if (!reachedEnd) throw new Error(`flipkart: sort "${sort || 'relevance'}" stopped before the last result page`);
  return { total };
}
