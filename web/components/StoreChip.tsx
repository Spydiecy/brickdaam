import { storeColor, storeName } from '@/lib/stores';

export function StoreChip({ id, size = 'md' }: { id: string; size?: 'sm' | 'md' }) {
  return (
    <span className={`store-chip store-chip--${size}`} style={{ '--store': storeColor(id) } as React.CSSProperties}>
      <span className="store-chip-dot" aria-hidden="true" />
      {storeName(id)}
    </span>
  );
}
