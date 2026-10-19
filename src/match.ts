import type { RawListing } from './types.js';

/** Strip store clutter (ad labels, odd leading marks) so titles read and match cleanly. */
export function cleanTitle(title: string): string {
  return title
    .replace(/&amp;/g, '&')
    .replace(/\bamp;/g, '&') // some sources drop the leading "&" of the entity
    .replace(/^\s*sponsored\s*ad\s*[-–:]?\s*/i, '')
    .replace(/^[\s|\u01C0\u2016\u00B7\u2022\-–—:]+/u, '') // stray leading marks such as "ǀ"
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Wording that only imitations and accessories use. It is deliberately narrow: real LEGO set names contain
 * words like "Clone" (Star Wars), "Display Stand" (NINJAGO), "Replica" (Icons), "alternative" builds and
 * "showcase", so none of those may be used as a signal. The main defence is the brand check in isLego;
 * this only catches titles that say outright they are compatible with, or made for, LEGO.
 */
const NOT_GENUINE = new RegExp(
  [
    String.raw`\bcompatible\s+(?:with|for)\s+(?:the\s+)?lego\b`, // "compatible with LEGO"
    String.raw`\blego[\s-]*compatible\b`, // "LEGO-compatible"
    String.raw`\bcompatible\s+lego\b`,
    String.raw`\blego[\s-]?like\b`,
    String.raw`\b(?:for|fits?|fit for|suitable for)\s+(?:the\s+)?lego\b`, // "light kit for LEGO"
    String.raw`\bknock[\s-]?off\b`,
    String.raw`\bbrick\s+separator\b`,
    String.raw`\bacrylic\s+(?:display|case|box)\b`,
    String.raw`\bdisplay\s+case\b`,
    String.raw`\bdust[\s-]?(?:cover|proof)\b`,
  ].join('|'),
  'i',
);

/**
 * Bundles of several sets ("Combo of 2 Cars", "Pack of 3", "Bundle") have one listing but more
 * than one set, so their price says nothing about any single set. Deliberately narrow: real LEGO
 * set names include "Combo" (Mini Ninja Combo Mech, City Combo Race Pack) and "Set of 2 ...
 * Vehicles" (one set), and "3-in-1" / "Pack of 1" are ordinary single sets.
 */
const BUNDLE = /\bcombo of ([2-9]|\d{2}|two|three|four)\b|\bpack of ([2-9]|two|three|four)\b|\bbundle\b|\b[2-9]\s*(?:sets|kits)\b/i;
export function isBundle(title: string): boolean {
  return BUNDLE.test(title);
}

/** True when the title reads like an imitation or an accessory rather than a LEGO product. */
export function looksNotGenuine(title: string): boolean {
  return NOT_GENUINE.test(title);
}

const brandIsLego = (brand: string | null | undefined) =>
  (brand ?? '').replace(/[^\p{L}]/gu, '').toLowerCase() === 'lego';

/**
 * Only genuine LEGO-brand products are tracked.
 *  - If the platform names a brand, it must be exactly LEGO (so "compatible bricks" sold under another
 *    brand, or "Lego-style" blocks, never pass, even if their title says "LEGO").
 *  - If the platform names no brand, the title itself has to start with LEGO.
 *  - Titles that read like imitations or accessories are rejected either way.
 */
export function isLego(l: Pick<RawListing, 'title' | 'brand'>): boolean {
  const title = cleanTitle(l.title);
  if (looksNotGenuine(title)) return false;
  if ((l.brand ?? '').trim()) return brandIsLego(l.brand);
  return /^lego\b/i.test(title);
}

/** Pull every 4 to 6 digit number out of a product title (LEGO set numbers). */
export function extractNumbers(title: string): string[] {
  return [...title.matchAll(/(?<!\d)(\d{4,6})(?!\d)/g)].map((m) => m[0]);
}

/**
 * Match a title to exactly one known set by its set number.
 * Returns null when there is no hit or the title is ambiguous.
 */
export function matchByNumber(title: string, knownSets: ReadonlySet<string>): string | null {
  const hits = new Set(extractNumbers(title).filter((n) => knownSets.has(n)));
  return hits.size === 1 ? [...hits][0] : null;
}

const norm = (s: string) =>
  ` ${s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()} `;

/**
 * Fallback for LEGO titles with no set number: find the catalog set whose full
 * name appears in the title. The longest name must be unique, otherwise null.
 */
export function createNameMatcher(sets: { set_number: string; name: string }[]) {
  const entries = sets
    .map((s) => ({ setNumber: s.set_number, name: norm(s.name) }))
    .filter((e) => e.name.trim().split(' ').length >= 2 && e.name.trim().length >= 10);

  return (title: string): string | null => {
    const t = norm(title);
    let best: { len: number; sets: Set<string> } | null = null;
    for (const e of entries) {
      if (!t.includes(e.name)) continue;
      if (!best || e.name.length > best.len) best = { len: e.name.length, sets: new Set([e.setNumber]) };
      else if (e.name.length === best.len) best.sets.add(e.setNumber);
    }
    return best && best.sets.size === 1 ? [...best.sets][0] : null;
  };
}
