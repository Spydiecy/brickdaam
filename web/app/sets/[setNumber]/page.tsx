'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { usePincode } from '@/components/PincodeProvider';
import { PriceHistory } from '@/components/PriceChart';
import { SetImage } from '@/components/SetImage';
import { StoreChip } from '@/components/StoreChip';
import { ago, num, percentOff, rupees, safeUrl, when } from '@/lib/format';
import { useNow, useSetDetail } from '@/lib/hooks';

export default function SetPage() {
  const { setNumber } = useParams<{ setNumber: string }>();
  const { pincode, city } = usePincode();
  const { data, error } = useSetDetail(setNumber, pincode);
  const now = useNow();

  if (error) {
    return (
      <div className="wrap">
        <div className="empty" role="alert">
          <h1>Set {setNumber}</h1>
          <p>{error}</p>
          <Link className="btn btn--outline" href="/">
            Back to all sets
          </Link>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="wrap detail detail--ghost" aria-busy="true">
        <div className="detail-media" />
        <div className="detail-info">
          <span className="ghost-line" />
          <span className="ghost-line ghost-line--short" />
        </div>
      </div>
    );
  }

  const { set, offers, history } = data;
  const inStock = offers.filter((o) => o.inStock);
  const best = inStock[0] ?? null; // API sorts in-stock first, then cheapest
  const off = best ? percentOff(best.price, best.mrp) : null;
  const highest = inStock.length > 1 ? inStock[inStock.length - 1].price : null;

  return (
    <div className="wrap">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/">All sets</Link>
        <span aria-hidden="true">/</span>
        {set.theme && (
          <>
            <span>{set.theme}</span>
            <span aria-hidden="true">/</span>
          </>
        )}
        <span aria-current="page">{set.name}</span>
      </nav>

      <div className="detail">
        <div className="detail-media">
          {set.imgUrl && (
            <SetImage setNumber={set.setNumber} alt={set.name} priority sizes="(max-width: 900px) 92vw, 560px" />
          )}
        </div>

        <div className="detail-info">
          {set.theme && <p className="eyebrow eyebrow--dark">{set.theme}</p>}
          <h1 className="detail-title">{set.name}</h1>
          <dl className="facts">
            <div>
              <dt>Set</dt>
              <dd>{set.setNumber}</dd>
            </div>
            {set.pieces ? (
              <div>
                <dt>Pieces</dt>
                <dd>{num(set.pieces)}</dd>
              </div>
            ) : null}
            {set.year ? (
              <div>
                <dt>Released</dt>
                <dd>{set.year}</dd>
              </div>
            ) : null}
          </dl>

          <div className={`buybox${best ? '' : ' buybox--out'}`}>
            {best ? (
              <>
                <p className="buybox-label">
                  Lowest price for {pincode}
                  {city ? `, ${city}` : ''}
                </p>
                <p className="buybox-price">
                  {rupees(best.price)}
                  {best.mrp && best.mrp > best.price && <s>MRP {rupees(best.mrp)}</s>}
                  {off && <span className="badge badge--deal">{off}% off</span>}
                </p>
                <p className="buybox-where">
                  at <StoreChip id={best.platform} /> · checked {ago(best.checkedAt, now)}
                </p>
                <a className="btn btn--yellow btn--lg btn--block" href={safeUrl(best.url)} target="_blank" rel="noopener noreferrer">
                  Buy on {best.name}
                  <span className="sr"> (opens in a new tab)</span>
                </a>
                {highest && highest > best.price && (
                  <p className="buybox-save">You save {rupees(highest - best.price)} over the priciest store.</p>
                )}
              </>
            ) : (
              <>
                <p className="buybox-label">Out of stock everywhere we check for {pincode}</p>
                <p className="buybox-where">
                  {offers.length
                    ? `Last seen at ${rupees(Math.min(...offers.map((o) => o.price)))}.`
                    : 'No store lists this set for your pincode yet.'}
                </p>
              </>
            )}
          </div>
        </div>
      </div>

      <section className="block" aria-labelledby="stores-title">
        <h2 id="stores-title" className="block-title">
          Compare {offers.length} {offers.length === 1 ? 'store' : 'stores'}
        </h2>
        {offers.length === 0 ? (
          <p className="muted">No store lists this set for {pincode} yet.</p>
        ) : (
          <ol className="offers">
            {offers.map((o, i) => {
              const pct = percentOff(o.price, o.mrp);
              return (
                <li key={`${o.platform}-${o.url}`} className={`offer${o.inStock ? '' : ' offer--out'}${i === 0 && o.inStock ? ' offer--best' : ''}`}>
                  <div className="offer-store">
                    <StoreChip id={o.platform} />
                    <p className="offer-title" title={o.title}>
                      {o.title}
                    </p>
                  </div>
                  <div className="offer-price">
                    <strong>{rupees(o.price)}</strong>
                    {o.mrp && o.mrp > o.price && <s>{rupees(o.mrp)}</s>}
                    {pct && <span className="offer-pct">{pct}% off</span>}
                  </div>
                  <div className="offer-stock">
                    <span className={o.inStock ? 'stock stock--in' : 'stock stock--out'}>
                      {o.inStock ? 'In stock' : 'Out of stock'}
                    </span>
                    <span className="muted">checked {ago(o.checkedAt, now)}</span>
                  </div>
                  <a className="btn btn--outline btn--sm" href={safeUrl(o.url)} target="_blank" rel="noopener noreferrer">
                    View<span className="sr"> on {o.name} (opens in a new tab)</span>
                  </a>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className="block" aria-labelledby="history-title">
        <h2 id="history-title" className="block-title">
          Price history
        </h2>
        <PriceHistory history={history} now={now} />
        {history.length > 1 && (
          <details className="history-table">
            <summary>Every recorded change, by store</summary>
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Store</th>
                  <th scope="col">Price</th>
                  <th scope="col">Stock</th>
                </tr>
              </thead>
              <tbody>
                {[...history].reverse().map((h, i) => (
                  <tr key={i}>
                    <td>{when(h.at)}</td>
                    <td>{h.name}</td>
                    <td>{rupees(h.price)}</td>
                    <td>{h.inStock ? 'In stock' : 'Out of stock'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </section>
    </div>
  );
}
