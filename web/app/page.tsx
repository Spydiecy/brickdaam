'use client';

import { useEffect, useMemo, useState } from 'react';
import { LiveRefresh } from '@/components/LiveRefresh';
import { usePincode } from '@/components/PincodeProvider';
import { SetCard } from '@/components/SetCard';
import { num } from '@/lib/format';
import { useLiveRefresh, useOverview } from '@/lib/hooks';
import type { SetRow } from '@/lib/types';

const PAGE = 48;
const FILTER_KEY = 'brickdaam:filters';

type Sort = 'stores' | 'deal' | 'low' | 'high' | 'name' | 'pieces' | 'newest';
interface Filters {
  q: string;
  theme: string;
  store: string;
  sort: Sort;
  inStock: boolean;
  /** Price range in rupees; empty string means no limit. */
  minPrice: string;
  maxPrice: string;
  /** Minimum % off MRP (0 = any). */
  minOff: number;
}
const DEFAULTS: Filters = { q: '', theme: '', store: '', sort: 'stores', inStock: true, minPrice: '', maxPrice: '', minOff: 0 };

const PRICE_PRESETS: { label: string; min: string; max: string }[] = [
  { label: 'Under ₹1k', min: '', max: '1000' },
  { label: '₹1k–3k', min: '1000', max: '3000' },
  { label: '₹3k–7k', min: '3000', max: '7000' },
  { label: '₹7k–15k', min: '7000', max: '15000' },
  { label: '₹15k+', min: '15000', max: '' },
];
const DISCOUNTS = [0, 10, 20, 30, 40];

/**
 * With a store selected, a set is judged by that store's own offer: its price, its discount, its
 * buy link. Otherwise by the cheapest in-stock offer across stores. Discounts are measured against
 * the lowest MRP any store shows (marketplace sellers sometimes inflate MRP).
 */
function viewFor(s: SetRow, store: string): SetRow {
  if (!store) return s;
  const o = s.offers[store];
  if (!o) return s;
  const mrps = Object.values(s.offers).map((x) => x.mrp).filter((m): m is number => m != null && m > 0);
  const ref = mrps.length ? Math.min(...mrps) : null;
  const mrp = ref != null && ref >= o.price ? ref : null;
  const best = o.inStock ? { platform: store, price: o.price, mrp, url: o.url } : null;
  const discount = best && mrp && mrp > o.price ? Math.round((1 - o.price / mrp) * 100) || null : null;
  return { ...s, best, discount };
}

/** The price a set is compared on: cheapest in stock, else the last price any store showed. */
function shownPrice(s: SetRow): number {
  return s.best?.price ?? Math.min(...Object.values(s.offers).map((o) => o.price));
}

const SORTS: Record<Sort, { label: string; fn: (a: SetRow, b: SetRow) => number }> = {
  stores: { label: 'On most stores', fn: (a, b) => stockCount(b) - stockCount(a) || (b.discount ?? -1) - (a.discount ?? -1) },
  deal: { label: 'Biggest discount', fn: (a, b) => (b.discount ?? -1) - (a.discount ?? -1) || price(a) - price(b) },
  low: { label: 'Price: low to high', fn: (a, b) => price(a) - price(b) },
  high: { label: 'Price: high to low', fn: (a, b) => (b.best?.price ?? -1) - (a.best?.price ?? -1) },
  newest: { label: 'Newest sets', fn: (a, b) => (b.year ?? 0) - (a.year ?? 0) || a.name.localeCompare(b.name) },
  pieces: { label: 'Most pieces', fn: (a, b) => (b.pieces ?? 0) - (a.pieces ?? 0) },
  name: { label: 'Name A to Z', fn: (a, b) => a.name.localeCompare(b.name) },
};
function stockCount(s: SetRow) {
  return Object.values(s.offers).filter((o) => o.inStock).length;
}
function price(s: SetRow) {
  return s.best?.price ?? Number.POSITIVE_INFINITY;
}

/** Filters survive going to a set page and back (session only). A ?store= link preselects a store. */
function useFilters() {
  const [f, setF] = useState<Filters>(DEFAULTS);
  useEffect(() => {
    let next = DEFAULTS;
    try {
      next = { ...DEFAULTS, ...JSON.parse(sessionStorage.getItem(FILTER_KEY) ?? '{}') };
    } catch {}
    const store = new URLSearchParams(window.location.search).get('store');
    if (store) next = { ...next, store };
    setF(next);
  }, []);
  const update = (patch: Partial<Filters>) =>
    setF((cur) => {
      const n = { ...cur, ...patch };
      sessionStorage.setItem(FILTER_KEY, JSON.stringify(n));
      return n;
    });
  return [f, update] as const;
}

const OPEN_KEY = 'brickdaam:filters-open';
const isPhone = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches;

/**
 * Extra filters (theme, store, price, discount) fold away. On desktop they expand inline and the
 * choice is remembered; on phones they open as a bottom sheet that always starts closed.
 */
function useFiltersOpen() {
  const [open, setOpenState] = useState(false);
  useEffect(() => {
    if (!isPhone()) setOpenState(localStorage.getItem(OPEN_KEY) === '1');
  }, []);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    if (!isPhone()) localStorage.setItem(OPEN_KEY, v ? '1' : '0');
  };
  // Phone sheet: lock page scroll behind it and close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpenState(false);
    document.addEventListener('keydown', onKey);
    const lock = isPhone();
    if (lock) document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      if (lock) document.body.style.overflow = '';
    };
  }, [open]);
  return [open, setOpen] as const;
}

export default function Home() {
  const { pincode, city, ready } = usePincode();
  const { data, error, loading, reload } = useOverview(pincode);
  const live = useLiveRefresh(pincode, () => void reload(true));
  const [f, update] = useFilters();
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useFiltersOpen();

  useEffect(() => setShown(PAGE), [f, pincode]);

  // A store or theme chosen at one pincode may not exist at another (Ozi is Gurugram only).
  // Drop it instead of silently filtering everything out while the dropdown shows "Any".
  useEffect(() => {
    if (!data) return;
    const patch: Partial<Filters> = {};
    if (f.store && !data.platforms.some((p) => p.id === f.store)) patch.store = '';
    if (f.theme && !data.sets.some((s) => s.theme === f.theme)) patch.theme = '';
    if (Object.keys(patch).length) update(patch);
  }, [data, f.store, f.theme]); // eslint-disable-line react-hooks/exhaustive-deps
  // When a refresh finishes, read the final prices once more.
  useEffect(() => {
    if (live.job && !live.active) void reload(true);
  }, [live.active]); // eslint-disable-line react-hooks/exhaustive-deps

  const sets = data?.sets ?? [];
  const themes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sets) if (s.theme) counts.set(s.theme, (counts.get(s.theme) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [sets]);

  const visible = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    return sets
      .filter((s) => !f.store || s.offers[f.store])
      .map((s) => viewFor(s, f.store))
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.setNumber.startsWith(q))
      .filter((s) => !f.theme || s.theme === f.theme)
      .filter((s) => !f.inStock || s.best)
      .filter((s) => {
        const p = shownPrice(s);
        return (!f.minPrice || p >= Number(f.minPrice)) && (!f.maxPrice || p <= Number(f.maxPrice));
      })
      .filter((s) => !f.minOff || (s.discount ?? 0) >= f.minOff)
      .sort(SORTS[f.sort].fn);
  }, [sets, f]);

  const extraFilters = f.minPrice !== '' || f.maxPrice !== '' || f.minOff > 0;
  const anyFilter = extraFilters || f.q !== '' || f.theme !== '' || f.store !== '';
  const storeName = data?.platforms.find((p) => p.id === f.store)?.name ?? f.store;
  const rupee = (v: string) => `₹${Number(v).toLocaleString('en-IN')}`;
  type Chip = { label: string; clear: Partial<Filters> };
  const chips: (Chip | null)[] = [
    f.store ? { label: storeName, clear: { store: '' } } : null,
    f.theme ? { label: f.theme, clear: { theme: '' } } : null,
    f.q.trim() ? { label: `“${f.q.trim()}”`, clear: { q: '' } } : null,
    f.minPrice || f.maxPrice
      ? {
          label: f.minPrice && f.maxPrice ? `${rupee(f.minPrice)}–${rupee(f.maxPrice)}` : f.minPrice ? `${rupee(f.minPrice)}+` : `Up to ${rupee(f.maxPrice)}`,
          clear: { minPrice: '', maxPrice: '' },
        }
      : null,
    f.minOff ? { label: `${f.minOff}%+ off`, clear: { minOff: 0 } } : null,
  ];
  const active = chips.filter((x): x is Chip => x !== null);
  const clearAll = () => update({ q: '', theme: '', store: '', minPrice: '', maxPrice: '', minOff: 0 });
  const advancedCount =
    (f.store ? 1 : 0) + (f.minPrice || f.maxPrice ? 1 : 0) + (f.minOff ? 1 : 0);

  const inStock = sets.filter((s) => s.best).length;
  const storesLive = data?.platforms.length ?? 0;

  if (ready && !pincode) {
    return (
      <section className="hero">
        <div className="wrap hero-inner hero-inner--solo">
          <div className="hero-copy">
            <p className="eyebrow">Start here</p>
            <h1 className="hero-title">Pick your pincode to see live LEGO prices.</h1>
            <p className="hero-text">Use “Deliver to” at the top of the page. Prices and stock depend on where you are.</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="hero">
        <div className="wrap hero-inner">
          <div className="hero-copy">
            <p className="eyebrow">{pincode ? `Prices for ${pincode}${city ? `, ${city}` : ''}` : 'Loading…'}</p>
            <h1 className="hero-title">Every LEGO set. Every store. The lowest price, right now.</h1>
            <p className="hero-text">
              Blinkit, Zepto, Instamart, Ozi, BigBasket, Amazon, Flipkart and FirstCry, compared for your pincode.
            </p>
            <dl className="hero-stats">
              <div>
                <dt>Sets listed</dt>
                <dd>{data ? num(sets.length) : '–'}</dd>
              </div>
              <div>
                <dt>In stock</dt>
                <dd>{data ? num(inStock) : '–'}</dd>
              </div>
              <div>
                <dt>Stores with prices</dt>
                <dd>{data ? storesLive : '–'}</dd>
              </div>
            </dl>
          </div>
          {data && (
            <LiveRefresh
              platforms={data.platforms}
              job={live.job}
              active={live.active}
              onStart={() => void live.start()}
              notice={live.notice}
              error={live.error}
            />
          )}
        </div>
      </section>

      <div className="wrap">
        {themes.length > 0 && (
          <div className="themes-wrap">
          <div className="themes" role="group" aria-label="Themes">
            <button type="button" className={`theme${!f.theme ? ' is-on' : ''}`} onClick={() => update({ theme: '' })}>
              All themes
            </button>
            {themes.map(([t, c]) => (
              <button
                key={t}
                type="button"
                className={`theme${f.theme === t ? ' is-on' : ''}`}
                aria-pressed={f.theme === t}
                onClick={() => update({ theme: f.theme === t ? '' : t })}
              >
                {t} <span>{c}</span>
              </button>
            ))}
          </div>
          </div>
        )}

        <section className="panel" aria-label="Filter and sort sets">
          <div className="panel-top">
            <div className="field field--grow">
              <label className="field-label" htmlFor="q">
                Search
              </label>
              <div className="control control--search">
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
                  <path d="m20 20-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <input
                  id="q"
                  type="search"
                  placeholder="Name or set number"
                  value={f.q}
                  onChange={(e) => update({ q: e.target.value })}
                />
              </div>
            </div>
            <div className="field field--sort">
              <label className="field-label" htmlFor="f-sort">
                Sort
              </label>
              <select id="f-sort" className="control" value={f.sort} onChange={(e) => update({ sort: e.target.value as Sort })}>
                {Object.entries(SORTS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
            <label className="toggle control">
              <input type="checkbox" checked={f.inStock} onChange={(e) => update({ inStock: e.target.checked })} />
              <span>In stock</span>
            </label>
            <button
              type="button"
              className={`filters-btn control${open ? ' is-open' : ''}`}
              aria-expanded={open}
              aria-controls="more-filters"
              aria-label={`Filters${advancedCount ? `, ${advancedCount} active` : ''}`}
              onClick={() => setOpen(!open)}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
              <span className="filters-text">Filters</span>
              {advancedCount > 0 && <span className="filters-count">{advancedCount}</span>}
              <svg className="filters-chev" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          <div
            id="more-filters"
            className={`xf${open ? ' is-open' : ''}`}
            role="region"
            aria-label="More filters"
          >
            <div className="xf-inner">
              <div className="sheet-head">
                <h2>Filters</h2>
                <button type="button" className="sheet-close" onClick={() => setOpen(false)} aria-label="Close filters">
                  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                    <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              <div className="xf-body">
                <div className="xf-row xf-row--pills">
                  <div className="group group--store">
                    <label className="field-label" htmlFor="f-store">
                      Store
                    </label>
                    <select id="f-store" className="control" value={f.store} onChange={(e) => update({ store: e.target.value })}>
                      <option value="">Any store</option>
                      {data?.platforms.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <fieldset className="group group--price">
                    <legend className="field-label">Price</legend>
                    <div className="group-body">
                      <div className="price-range">
                        <label className="control control--price">
                          <span className="sr">Minimum price in rupees</span>
                          <span aria-hidden="true">₹</span>
                          <input
                            inputMode="numeric"
                            placeholder="Min"
                            value={f.minPrice}
                            onChange={(e) => update({ minPrice: e.target.value.replace(/\D/g, '') })}
                          />
                        </label>
                        <span className="price-dash" aria-hidden="true">–</span>
                        <label className="control control--price">
                          <span className="sr">Maximum price in rupees</span>
                          <span aria-hidden="true">₹</span>
                          <input
                            inputMode="numeric"
                            placeholder="Max"
                            value={f.maxPrice}
                            onChange={(e) => update({ maxPrice: e.target.value.replace(/\D/g, '') })}
                          />
                        </label>
                      </div>
                      <div className="pill-row">
                        {PRICE_PRESETS.map((p) => {
                          const on = f.minPrice === p.min && f.maxPrice === p.max;
                          return (
                            <button
                              key={p.label}
                              type="button"
                              className={`pill${on ? ' is-on' : ''}`}
                              aria-pressed={on}
                              onClick={() => update(on ? { minPrice: '', maxPrice: '' } : { minPrice: p.min, maxPrice: p.max })}
                            >
                              {p.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </fieldset>

                  <fieldset className="group group--off">
                    <legend className="field-label">Discount off MRP</legend>
                    <div className="group-body">
                      <div className="pill-row">
                        {DISCOUNTS.map((d) => (
                          <button
                            key={d}
                            type="button"
                            className={`pill${f.minOff === d ? ' is-on' : ''}`}
                            aria-pressed={f.minOff === d}
                            onClick={() => update({ minOff: d })}
                          >
                            {d === 0 ? 'Any' : `${d}%+`}
                          </button>
                        ))}
                      </div>
                    </div>
                  </fieldset>
                </div>
              </div>

              <div className="sheet-foot">
                <button type="button" className="btn btn--outline" onClick={clearAll} disabled={!anyFilter}>
                  Clear all
                </button>
                <button type="button" className="btn btn--dark" onClick={() => setOpen(false)}>
                  Show {data ? num(visible.length) : ''} {visible.length === 1 ? 'set' : 'sets'}
                </button>
              </div>
            </div>
          </div>
        </section>
        {open && <div className="sheet-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />}

        <div className="result-bar" aria-live="polite">
          <p className="result-count">
            {data ? `${num(visible.length)} ${visible.length === 1 ? 'set' : 'sets'}` : loading ? 'Loading prices…' : ''}
            {f.store && data ? <span className="result-note"> at {storeName}{f.inStock ? ', in stock' : ''}</span> : null}
          </p>
          {active.length > 0 && (
            <ul className="active-filters" aria-label="Active filters">
              {active.map((a) => (
                <li key={a.label}>
                  <button type="button" onClick={() => update(a.clear)} aria-label={`Remove filter ${a.label}`}>
                    {a.label} <span aria-hidden="true">×</span>
                  </button>
                </li>
              ))}
              {active.length > 0 && (
                <li>
                  <button type="button" className="active-clear" onClick={clearAll}>
                    Clear all
                  </button>
                </li>
              )}
            </ul>
          )}
          {data?.unserved.length ? (
            <p className="result-note">Not delivering here: {data.unserved.map((u) => u.name).join(', ')}</p>
          ) : null}
        </div>

        {error && (
          <div className="empty" role="alert">
            <h2>Couldn’t load prices</h2>
            <p>{error}. Is the tracker running? Start it with “npm start”.</p>
          </div>
        )}

        {data && sets.length === 0 && (
          <div className="empty">
            <h2>No prices for {pincode} yet</h2>
            <p>Hit “Fetch live rates” above to check every store now. The first check takes a few minutes.</p>
          </div>
        )}

        {data && sets.length > 0 && visible.length === 0 && (
          <div className="empty">
            <h2>No sets match these filters</h2>
            <p>
              {active.length
                ? `Filtering by ${active.map((a) => a.label).join(', ')}${f.inStock ? ', in stock only' : ''}.`
                : 'Nothing is in stock. Untick “In stock only” to see last seen prices.'}
            </p>
            {active.length > 0 && (
              <button type="button" className="btn btn--outline" onClick={clearAll}>
                Clear all filters
              </button>
            )}
          </div>
        )}

        <ul className="grid">
          {visible.slice(0, shown).map((s, i) => (
            <li key={s.setNumber}>
              <SetCard set={s} priority={i < 4} />
            </li>
          ))}
          {!data &&
            !error &&
            Array.from({ length: 8 }, (_, i) => (
              <li key={i} aria-hidden="true">
                <div className="card card--ghost">
                  <div className="card-media" />
                  <div className="card-body">
                    <span className="ghost-line" />
                    <span className="ghost-line ghost-line--short" />
                  </div>
                </div>
              </li>
            ))}
        </ul>

        {visible.length > shown && (
          <div className="more">
            <p>
              Showing {num(shown)} of {num(visible.length)}
            </p>
            <button type="button" className="btn btn--outline" onClick={() => setShown((n) => n + PAGE)}>
              Show more sets
            </button>
          </div>
        )}
      </div>
    </>
  );
}
