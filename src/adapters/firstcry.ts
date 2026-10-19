import type { Adapter, Pincode, RawListing } from '../types.js';

/**
 * FirstCry sells one national catalogue: price, MRP and stock were identical for pincodes in
 * Gurugram, Bengaluru, Mumbai and Imphal in testing; only delivery time differs. So a single
 * crawl serves every pincode, and results are cached briefly so a run with many pincodes
 * does not repeat it. No browser is needed: the listing page's own JSON endpoint answers plain HTTP.
 */
const ORIGIN = 'https://www.firstcry.com';
const ENDPOINT = `${ORIGIN}/svcs/SearchResult.svc/GetSearchResultProductsPaging`;
const LEGO_BRAND_ID = '354';
const PAGE_SIZE = 20;
const MAX_PAGES = 80;
const PAGE_DELAY_MS = 400;
const CACHE_MS = 10 * 60_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

// The endpoint expects the full parameter list the site sends; unused ones stay empty.
const EMPTY_PARAMS = [
  'SubCatId', 'BrandId', 'Price', 'Age', 'Color', 'OptionalFilter', 'OutOfStock',
  ...Array.from({ length: 15 }, (_, i) => `Type${i + 1}`),
  'combo', 'discount', 'searchwithincat', 'ProductidQstr', 'searchrank', 'pmonths', 'cgen',
  'PriceQstr', 'DiscountQstr', 'sorting', 'Rating', 'Offer', 'skills', 'material',
  'curatedcollections', 'measurement', 'gender', 'exclude', 'premium', 'deliverytype',
  'authors', 'booktype', 'character', 'collections', 'format', 'genre', 'booklanguage',
  'publication', 'skill',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function pageUrl(pageNo: number): string {
  const q = new URLSearchParams({
    PageNo: String(pageNo),
    PageSize: String(PAGE_SIZE),
    SortExpression: 'bestseller',
    OnSale: '0',
    SearchString: 'brand',
    MasterBrand: LEGO_BRAND_ID,
    pcode: '0',
    isclub: '0',
  });
  for (const p of EMPTY_PARAMS) q.set(p, '');
  return `${ENDPOINT}?${q}`;
}

async function fetchPage(pageNo: number): Promise<any[]> {
  const res = await fetch(pageUrl(pageNo), {
    headers: { 'user-agent': UA, referer: `${ORIGIN}/lego/0/0/${LEGO_BRAND_ID}`, accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`firstcry page ${pageNo} returned HTTP ${res.status}`);
  let products: any;
  try {
    // The endpoint wraps its payload as a JSON string inside JSON.
    products = JSON.parse(JSON.parse(await res.text()).ProductResponse).Products;
  } catch {
    throw new Error(`firstcry page ${pageNo}: unexpected response format (layout change or block page)`);
  }
  if (!Array.isArray(products)) throw new Error(`firstcry page ${pageNo}: no Products array`);
  return products;
}

function toListing(p: any): RawListing | null {
  const id = String(p?.PId ?? '');
  const title = String(p?.PNm ?? '').trim();
  const mrp = num(p?.MRP);
  const price = num(p?.discprice) ?? mrp;
  if (!id || !title || price == null) return null;
  return {
    platformProductId: id,
    title,
    brand: p?.BNm ?? null,
    price: Math.round(price * 100) / 100,
    mrp: mrp != null && mrp >= price ? mrp : null,
    inStock: Number(p?.CrntStock ?? 0) > 0,
    url: `${ORIGIN}/lego/${slug(title)}/${id}/product-detail`,
  };
}

let cache: { at: number; listings: RawListing[] } | null = null;
let inflight: Promise<RawListing[]> | null = null;

async function crawl(): Promise<RawListing[]> {
  const byId = new Map<string, RawListing>();
  let reachedEnd = false;
  for (let n = 1; n <= MAX_PAGES; n++) {
    if (n > 1) await sleep(PAGE_DELAY_MS);
    const products = await fetchPage(n);
    if (products.length === 0) {
      reachedEnd = true;
      break;
    }
    for (const p of products) {
      const l = toListing(p);
      if (l) byId.set(l.platformProductId, l);
    }
  }
  if (!reachedEnd) throw new Error(`firstcry still had products after ${MAX_PAGES} pages; layout change?`);
  if (byId.size === 0) throw new Error('firstcry returned no LEGO products at all');
  return [...byId.values()];
}

export const firstcry: Adapter = {
  id: 'firstcry',
  name: 'FirstCry',
  locationKey: 'pincode',
  minIntervalMin: 30,

  async fetchLegoListings(_pin: Pincode): Promise<RawListing[]> {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.listings;
    inflight ??= crawl()
      .then((listings) => {
        cache = { at: Date.now(), listings };
        return listings;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  },
};
