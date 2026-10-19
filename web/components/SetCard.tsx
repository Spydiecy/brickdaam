import Link from 'next/link';
import { num, rupees } from '@/lib/format';
import type { SetRow } from '@/lib/types';
import { SetImage } from './SetImage';
import { StoreChip } from './StoreChip';

export function SetCard({ set, priority = false }: { set: SetRow; priority?: boolean }) {
  const offers = Object.values(set.offers);
  const inStockStores = offers.filter((o) => o.inStock).length;
  // When nothing is in stock, show the last price seen so the card still says something useful.
  const lastSeen = set.best ? null : Math.min(...offers.map((o) => o.price));

  return (
    <Link href={`/sets/${set.setNumber}`} className={`card${set.best ? '' : ' card--out'}`}>
      <div className="card-media">
        {set.imgUrl ? (
          <SetImage
            setNumber={set.setNumber}
            alt={set.name}
            sizes="(max-width: 640px) 46vw, 260px"
            priority={priority}
          />
        ) : (
          <span className="card-noimg" aria-hidden="true" />
        )}
        {set.discount ? <span className="badge badge--deal">{set.discount}% off</span> : null}
        {inStockStores > 1 && <span className="badge badge--stores">{inStockStores} stores</span>}
      </div>
      <div className="card-body">
        <p className="card-meta">
          <span className="card-number">{set.setNumber}</span>
          {set.theme && <span>{set.theme}</span>}
        </p>
        <h3 className="card-name">{set.name}</h3>
        {set.pieces ? <p className="card-pieces">{num(set.pieces)} pieces</p> : null}

        <div className="card-foot">
          {set.best ? (
            <>
              <p className="card-price">
                <strong>{rupees(set.best.price)}</strong>
                {set.best.mrp && set.best.mrp > set.best.price && <s>{rupees(set.best.mrp)}</s>}
              </p>
              <p className="card-where">
                Lowest at <StoreChip id={set.best.platform} size="sm" />
              </p>
            </>
          ) : (
            <>
              <p className="card-price card-price--out">Out of stock</p>
              <p className="card-where">Last seen at {rupees(lastSeen ?? 0)}</p>
            </>
          )}
        </div>
      </div>
    </Link>
  );
}
