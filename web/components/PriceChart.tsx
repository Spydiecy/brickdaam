import { rupees, when } from '@/lib/format';
import { storeName } from '@/lib/stores';
import type { HistoryPoint } from '@/lib/types';

interface Step {
  t: number;
  /** Cheapest in-stock price across stores from this moment, or null when nothing was in stock. */
  price: number | null;
  store: string | null;
}

/**
 * Replays every recorded price/stock change in time order and keeps, at each moment, the
 * cheapest in-stock offer across stores. That one line answers "is now a good time to buy?".
 */
function bestOverTime(history: HistoryPoint[]): Step[] {
  const latest = new Map<string, { price: number; inStock: boolean }>();
  const steps: Step[] = [];
  const sorted = [...history].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const h of sorted) {
    latest.set(h.platform, { price: h.price, inStock: h.inStock });
    let price: number | null = null;
    let store: string | null = null;
    for (const [id, o] of latest) {
      if (o.inStock && (price === null || o.price < price)) {
        price = o.price;
        store = id;
      }
    }
    const t = Date.parse(h.at);
    const prev = steps[steps.length - 1];
    if (prev && prev.price === price) continue; // no change in the best price
    if (prev && t - prev.t < 60_000) steps.pop(); // first crawl writes every store within seconds
    steps.push({ t, price, store });
  }
  return steps;
}

const W = 720;
const H = 200;
const PAD = { top: 14, right: 12, bottom: 26, left: 62 };

export function PriceHistory({ history, now }: { history: HistoryPoint[]; now: number }) {
  if (history.length === 0) return <p className="muted">No prices recorded for this set at your pincode yet.</p>;

  const steps = bestOverTime(history);
  const priced = steps.filter((s): s is Step & { price: number; store: string } => s.price !== null);
  const since = Math.min(...history.map((h) => Date.parse(h.at)));
  const current = steps[steps.length - 1];
  const low = priced.length ? priced.reduce((a, b) => (b.price < a.price ? b : a)) : null;
  const high = priced.length ? priced.reduce((a, b) => (b.price > a.price ? b : a)) : null;

  const stats = (
    <dl className="ph-stats">
      <div>
        <dt>Now</dt>
        <dd>{current?.price != null ? rupees(current.price) : 'Out of stock'}</dd>
        {current?.store && <span>{storeName(current.store)}</span>}
      </div>
      <div>
        <dt>Lowest seen</dt>
        <dd>{low ? rupees(low.price) : '–'}</dd>
        {low && (
          <span>
            {storeName(low.store)}, {when(new Date(low.t).toISOString())}
          </span>
        )}
      </div>
      <div>
        <dt>Highest seen</dt>
        <dd>{high ? rupees(high.price) : '–'}</dd>
        {high && <span>{storeName(high.store)}</span>}
      </div>
      <div>
        <dt>Tracking since</dt>
        <dd className="ph-small">{when(new Date(since).toISOString())}</dd>
      </div>
    </dl>
  );

  const verdict =
    current?.price != null && low
      ? current.price <= low.price
        ? 'This is the lowest price we have seen for it.'
        : `That is ${rupees(current.price - low.price)} above the lowest we have seen.`
      : null;

  // A chart needs at least one change of the best price to say anything.
  if (priced.length < 2) {
    return (
      <>
        {stats}
        <p className="muted">
          The lowest price has not changed since we started tracking. A chart appears here once it does.
        </p>
      </>
    );
  }

  const t0 = since;
  const t1 = Math.max(now, t0 + 60_000);
  const values = priced.map((s) => s.price);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || hi * 0.1;
  const yLo = lo - span * 0.15;
  const yHi = hi + span * 0.15;
  const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0)) * (W - PAD.left - PAD.right);
  const y = (p: number) => PAD.top + (1 - (p - yLo) / (yHi - yLo)) * (H - PAD.top - PAD.bottom);

  // Step path through the best price; gaps where nothing was in stock.
  const paths: string[] = [];
  let d = '';
  steps.forEach((s, i) => {
    const end = i + 1 < steps.length ? steps[i + 1].t : t1;
    if (s.price === null) {
      if (d) paths.push(d);
      d = '';
      return;
    }
    d += `${d ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(s.price).toFixed(1)} L${x(end).toFixed(1)},${y(s.price).toFixed(1)} `;
  });
  if (d) paths.push(d);

  return (
    <>
      {stats}
      {verdict && <p className="ph-verdict">{verdict}</p>}
      <figure className="chart">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Lowest in-stock price over time, from ${rupees(lo)} to ${rupees(hi)}`}>
          {[yHi - (yHi - yLo) * 0.15, (yLo + yHi) / 2, yLo + (yHi - yLo) * 0.15].map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="chart-grid" />
              <text x={PAD.left - 8} y={y(v) + 4} textAnchor="end" className="chart-axis">
                {rupees(v)}
              </text>
            </g>
          ))}
          {low && <line x1={PAD.left} x2={W - PAD.right} y1={y(low.price)} y2={y(low.price)} className="chart-low" />}
          {paths.map((p, i) => (
            <path key={i} d={p} className="chart-line" />
          ))}
          {priced.map((s, i) => (
            <circle key={i} cx={x(s.t)} cy={y(s.price)} r="4" className="chart-dot">
              <title>
                {rupees(s.price)} at {storeName(s.store)}, {when(new Date(s.t).toISOString())}
              </title>
            </circle>
          ))}
          <text x={PAD.left} y={H - 6} className="chart-axis">
            {when(new Date(t0).toISOString())}
          </text>
          <text x={W - PAD.right} y={H - 6} textAnchor="end" className="chart-axis">
            now
          </text>
        </svg>
        <figcaption className="muted">Cheapest in-stock price across all stores for your pincode. Dashed: lowest seen.</figcaption>
      </figure>
    </>
  );
}
