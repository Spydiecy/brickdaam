import { gunzipSync } from 'node:zlib';
import { db } from './db.js';

const BASE = 'https://cdn.rebrickable.com/media/downloads';
// Very old sets collide with ordinary numbers in product titles (years, piece counts).
const MIN_YEAR = Number(process.env.CATALOG_MIN_YEAR ?? 2010);

async function download(name: string): Promise<string> {
  const res = await fetch(`${BASE}/${name}`, { headers: { 'user-agent': 'lego-tracker/0.1' } });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8');
}

/** Minimal CSV parser that handles quoted fields. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Import/refresh the full LEGO catalog from Rebrickable's free CSV dumps (no API key). */
export async function importCatalog(): Promise<{ sets: number }> {
  const [setsCsv, themesCsv] = await Promise.all([download('sets.csv.gz'), download('themes.csv.gz')]);

  const themes = new Map<string, { name: string; parent: string }>();
  for (const [id, name, parent] of parseCsv(themesCsv).slice(1)) themes.set(id, { name, parent });
  const rootTheme = (id: string): string => {
    let t = themes.get(id);
    while (t?.parent && themes.get(t.parent)) t = themes.get(t.parent);
    return t?.name ?? '';
  };

  const upsert = db.prepare(`
    INSERT INTO sets (set_number, name, theme, year, pieces, img_url)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(set_number) DO UPDATE SET
      name = excluded.name, theme = excluded.theme, year = excluded.year,
      pieces = excluded.pieces, img_url = excluded.img_url`);

  let count = 0;
  db.transaction(() => {
    for (const [setNum, name, year, themeId, parts, img] of parseCsv(setsCsv).slice(1)) {
      if (!setNum.endsWith('-1')) continue; // main release only, skip variants like -2
      const number = setNum.slice(0, -2);
      if (!/^\d{4,6}$/.test(number)) continue; // product titles only carry numeric set ids
      if (Number(year) < MIN_YEAR) continue;
      upsert.run(number, name, rootTheme(themeId), Number(year), Number(parts) || null, img || null);
      count++;
    }
  })();
  return { sets: count };
}
