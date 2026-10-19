// A colour per store so they are easy to tell apart in lists. Names only, no store logos.
const STORES: Record<string, { name: string; color: string; kind: 'quick' | 'retail' }> = {
  blinkit: { name: 'Blinkit', color: '#0C831F', kind: 'quick' },
  zepto: { name: 'Zepto', color: '#5B1FA6', kind: 'quick' },
  ozi: { name: 'Ozi', color: '#C2336B', kind: 'quick' },
  instamart: { name: 'Instamart', color: '#E86A10', kind: 'quick' },
  bigbasket: { name: 'BigBasket', color: '#5E8F16', kind: 'quick' },
  'flipkart-minutes': { name: 'Flipkart Minutes', color: '#B4006B', kind: 'quick' },
  'amazon-now': { name: 'Amazon Now', color: '#007185', kind: 'quick' },
  amazon: { name: 'Amazon', color: '#C45500', kind: 'retail' },
  flipkart: { name: 'Flipkart', color: '#2463D1', kind: 'retail' },
  firstcry: { name: 'FirstCry', color: '#D9480F', kind: 'retail' },
};

export const storeName = (id: string) => STORES[id]?.name ?? id;
export const storeColor = (id: string) => STORES[id]?.color ?? '#555';
export const isQuickCommerce = (id: string) => STORES[id]?.kind === 'quick';
