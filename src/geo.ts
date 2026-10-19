import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from './db.js';

const URL_ZIP = 'https://download.geonames.org/export/zip/IN.zip';

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Import coordinates for every Indian pincode (about 19k) from GeoNames. */
export async function importGeoPincodes(): Promise<{ pincodes: number }> {
  const res = await fetch(URL_ZIP, { headers: { 'user-agent': 'lego-tracker/0.1' } });
  if (!res.ok) throw new Error(`GeoNames download failed: HTTP ${res.status}`);

  const dir = mkdtempSync(join(tmpdir(), 'geonames-'));
  let text: string;
  try {
    const zip = join(dir, 'IN.zip');
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    text = execFileSync('unzip', ['-p', zip, 'IN.txt'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // columns: country, postal, place, state, stateCode, district, ..., lat(9), lng(10)
  const byPin = new Map<string, { city: string; lat: number[]; lng: number[] }>();
  for (const line of text.split('\n')) {
    const c = line.split('\t');
    const pin = c[1];
    const lat = Number(c[9]);
    const lng = Number(c[10]);
    if (!/^[1-9]\d{5}$/.test(pin ?? '')) continue;
    if (!(lat > 6 && lat < 37.5 && lng > 68 && lng < 98)) continue; // inside India's bounding box
    const e = byPin.get(pin) ?? { city: c[5] || c[2] || c[3] || 'Unknown', lat: [], lng: [] };
    e.lat.push(lat);
    e.lng.push(lng);
    byPin.set(pin, e);
  }

  const upsert = db.prepare(`
    INSERT INTO geo_pincodes (pincode, city, lat, lng) VALUES (?, ?, ?, ?)
    ON CONFLICT(pincode) DO UPDATE SET city = excluded.city, lat = excluded.lat, lng = excluded.lng`);
  db.transaction(() => {
    for (const [pin, e] of byPin) upsert.run(pin, e.city, median(e.lat), median(e.lng));
  })();
  return { pincodes: byPin.size };
}

export interface Point {
  lat: number;
  lng: number;
}

const KM_PER_DEG = 111.32;
const ring = (p: Point, km: number): Point[] =>
  Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    return {
      lat: p.lat + (km * Math.sin(a)) / KM_PER_DEG,
      lng: p.lng + (km * Math.cos(a)) / (KM_PER_DEG * Math.cos((p.lat * Math.PI) / 180)),
    };
  });

/**
 * Ordered points to try for a pincode: the geocoded point and the GeoNames point first,
 * then rings of 2, 4 and 7 km around each. Coordinate-keyed platforms use the first one
 * they actually serve.
 */
export function candidatePoints(pincode: string): Point[] {
  const bases: Point[] = [];
  const geocoded = db.prepare('SELECT lat, lng FROM pincodes WHERE pincode = ?').get(pincode) as Point | undefined;
  const geonames = db.prepare('SELECT lat, lng FROM geo_pincodes WHERE pincode = ?').get(pincode) as Point | undefined;
  if (geocoded) bases.push(geocoded);
  if (geonames) bases.push(geonames);

  const out: Point[] = [...bases];
  for (const km of [2, 4, 7]) for (const b of bases) out.push(...ring(b, km));

  const seen = new Set<string>();
  return out.filter((p) => {
    const k = `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}
