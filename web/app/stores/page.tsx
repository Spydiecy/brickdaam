'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePincode } from '@/components/PincodeProvider';
import { StoreChip } from '@/components/StoreChip';
import { api } from '@/lib/api';
import { ago, num } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { isQuickCommerce } from '@/lib/stores';
import type { PlatformStatus } from '@/lib/types';

export default function StoresPage() {
  const { pincode, city } = usePincode();
  const [stores, setStores] = useState<PlatformStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  useEffect(() => {
    if (!pincode) return;
    setStores(null);
    api<{ platforms: PlatformStatus[] }>(`/api/status?pincode=${pincode}`)
      .then((d) => setStores(d.platforms))
      .catch((e) => setError((e as Error).message));
  }, [pincode]);

  return (
    <div className="wrap">
      <header className="page-head">
        <p className="eyebrow eyebrow--dark">{pincode ? `${pincode}${city ? `, ${city}` : ''}` : ''}</p>
        <h1 className="page-title">Stores we check</h1>
        <p className="muted">
          Quick-commerce apps are checked every 5 minutes. Big retailers every 15 to 30 minutes, or right away with
          “Fetch live rates” on the home page.
        </p>
      </header>

      {error && <p role="alert">{error}</p>}

      <ul className="stores">
        {stores?.map((s) => (
          <li key={s.id} className="store">
            <div className="store-top">
              <StoreChip id={s.id} />
              <span className="store-kind">{isQuickCommerce(s.id) ? 'Delivery in minutes' : 'Regular delivery'}</span>
            </div>
            {s.serves === false ? (
              <p className="store-num store-num--muted">Doesn’t deliver here</p>
            ) : (
              <p className="store-num">
                <strong>{num(s.inStock)}</strong> in stock <span className="muted">of {num(s.listings)} sets</span>
              </p>
            )}
            <p className="muted">Checked {ago(s.lastChecked ?? s.lastAttempt, now)}</p>
            {s.listings > 0 && (
              <Link className="btn btn--outline btn--sm" href={`/?store=${s.id}`}>
                Browse {s.name}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
