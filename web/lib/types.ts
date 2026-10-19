// Shapes returned by the tracker API (src/api.ts). Kept in one place so pages agree on them.

export interface Offer {
  title: string;
  url: string;
  price: number;
  mrp: number | null;
  inStock: boolean;
  checkedAt: string;
  changedAt: string;
}

export interface SetRow {
  setNumber: string;
  name: string;
  theme: string | null;
  pieces: number | null;
  year: number | null;
  imgUrl: string | null;
  /** Latest offer per platform id. */
  offers: Record<string, Offer>;
  /** Cheapest in-stock offer, or null when nothing is in stock. */
  best: { platform: string; price: number; mrp: number | null; url: string } | null;
  discount: number | null;
}

export interface PlatformInfo {
  id: string;
  name: string;
  lastChecked: string;
  staleAfterMin: number;
}

export interface Overview {
  pincode: string;
  city: string;
  platforms: PlatformInfo[];
  unserved: { id: string; name: string }[];
  sets: SetRow[];
}

export interface Pincode {
  pincode: string;
  city: string;
}

export type ProgressState =
  | { state: 'queued' }
  | { state: 'running' }
  | { state: 'done'; listings: number }
  | { state: 'unserved' }
  | { state: 'failed'; error: string };

export interface RefreshJob {
  id: number;
  pincode: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: Record<string, ProgressState>;
  error: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface StoreOffer extends Offer {
  platform: string;
  name: string;
}

export interface HistoryPoint {
  platform: string;
  name: string;
  price: number;
  mrp: number | null;
  inStock: boolean;
  at: string;
}

export interface SetDetail {
  set: Omit<SetRow, 'offers' | 'best' | 'discount'>;
  offers: StoreOffer[];
  history: HistoryPoint[];
}

export interface PlatformStatus {
  id: string;
  name: string;
  listings: number;
  inStock: number;
  lastChecked: string | null;
  lastAttempt: string | null;
  serves: boolean | null;
}
