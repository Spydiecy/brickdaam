import { db } from './db.js';
import type { Pincode } from './types.js';

const PINCODE_RE = /^[1-9]\d{5}$/;
let lastGeocode = 0;

export function isValidPincode(p: string): boolean {
  return PINCODE_RE.test(p);
}

export function getPincode(pincode: string): Pincode | undefined {
  return db.prepare('SELECT * FROM pincodes WHERE pincode = ?').get(pincode) as Pincode | undefined;
}

async function geocode(pincode: string): Promise<Pincode | null> {
  // Nominatim usage policy: at most 1 request per second.
  const wait = lastGeocode + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeocode = Date.now();

  const url =
    'https://nominatim.openstreetmap.org/search?' +
    new URLSearchParams({ postalcode: pincode, country: 'India', format: 'jsonv2', addressdetails: '1', limit: '1' });
  const res = await fetch(url, { headers: { 'user-agent': 'lego-tracker/0.1 (personal price tracker)' } });
  if (!res.ok) throw new Error(`geocoding failed: HTTP ${res.status}`);
  const hit = ((await res.json()) as any[])[0];
  if (!hit) return null;
  const a = hit.address ?? {};
  return {
    pincode,
    city: a.city ?? a.town ?? a.state_district ?? a.county ?? a.state ?? 'Unknown',
    lat: Number(hit.lat),
    lng: Number(hit.lon),
  };
}

/**
 * Track any Indian pincode. Uses the GeoNames table when present (run `cli geo` once),
 * adds an OpenStreetMap geocode as a second candidate point, and fails only when neither knows it.
 */
export async function ensurePincode(pincode: string): Promise<Pincode> {
  if (!isValidPincode(pincode)) throw new Error(`invalid pincode: ${pincode}`);
  const existing = getPincode(pincode);
  if (existing) return existing;

  const geo = db.prepare('SELECT city, lat, lng FROM geo_pincodes WHERE pincode = ?').get(pincode) as
    | { city: string; lat: number; lng: number }
    | undefined;

  let found: Pincode | null = null;
  try {
    found = await geocode(pincode);
  } catch (err) {
    if (!geo) throw err; // GeoNames can still carry us if the geocoder is down
  }
  if (!found && geo) found = { pincode, ...geo };
  if (!found) throw new Error(`could not locate pincode ${pincode}`);

  // Prefer GeoNames' district name: it is a real city/district, not a ward label.
  if (geo) found.city = geo.city;
  db.prepare('INSERT INTO pincodes (pincode, city, lat, lng) VALUES (@pincode, @city, @lat, @lng)').run(found);
  return found;
}
