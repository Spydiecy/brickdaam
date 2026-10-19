const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const count = new Intl.NumberFormat('en-IN');
const stamp = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export const rupees = (n: number) => inr.format(Math.round(n));
export const num = (n: number) => count.format(n);
export const when = (iso: string) => stamp.format(new Date(iso));

/** "just now", "4 min ago", "2 h ago", "3 d ago". `now` lets callers re-render on a timer. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function percentOff(price: number, mrp: number | null): number | null {
  if (!mrp || mrp <= price) return null;
  const p = Math.round((1 - price / mrp) * 100);
  return p >= 1 ? p : null;
}

/** Only follow http(s) links that came back from the stores. */
export function safeUrl(u: string): string {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '#';
  } catch {
    return '#';
  }
}
