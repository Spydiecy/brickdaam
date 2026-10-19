import { mkdirSync, existsSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { db } from './db.js';

/**
 * Set photos from Rebrickable are full-size originals (up to 2400px, ~1.8 MB each), far too heavy
 * for a grid. Each photo is downloaded once, resized to small WebP files and kept on disk, so the
 * site serves ~15-40 KB thumbnails from this machine instead of megabytes from a slow CDN.
 */
export const WIDTHS = [320, 640, 1000] as const;
export type Width = (typeof WIDTHS)[number];

const DIR = process.env.IMG_DIR ?? fileURLToPath(new URL('../data/img/', import.meta.url));
mkdirSync(DIR, { recursive: true });

const pathFor = (setNumber: string, w: Width) => `${DIR}${setNumber}-${w}.webp`;
const inflight = new Map<string, Promise<void>>();

async function download(url: string): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'lego-tracker/0.1' }, signal: AbortSignal.timeout(45_000) });
      if (!res.ok) throw new Error(`image HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

/** Download the original once and write every thumbnail width. Concurrent callers share the work. */
function build(setNumber: string): Promise<void> {
  let p = inflight.get(setNumber);
  if (p) return p;
  p = (async () => {
    // Only sets that a store actually lists, so the endpoint can not be used to make this server
    // download the whole catalogue.
    const row = db
      .prepare('SELECT s.img_url FROM sets s WHERE s.set_number = ? AND EXISTS (SELECT 1 FROM listings l WHERE l.set_number = s.set_number)')
      .get(setNumber) as
      | { img_url: string | null }
      | undefined;
    if (!row?.img_url) throw new Error('no image for this set');
    const original = await download(row.img_url);
    for (const w of WIDTHS) {
      const out = await sharp(original)
        .resize({ width: w, height: w, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .webp({ quality: w <= 320 ? 72 : 78 })
        .toBuffer();
      const file = pathFor(setNumber, w);
      await writeFile(`${file}.tmp`, out);
      await rename(`${file}.tmp`, file); // never serve a half-written file
    }
  })().finally(() => inflight.delete(setNumber));
  inflight.set(setNumber, p);
  return p;
}

/** The thumbnail for a set at the nearest allowed width, building it on first request. */
export async function thumbnail(setNumber: string, requested: number): Promise<Buffer> {
  const w = WIDTHS.find((x) => x >= requested) ?? WIDTHS[WIDTHS.length - 1];
  const file = pathFor(setNumber, w);
  if (!existsSync(file)) await build(setNumber);
  return readFile(file);
}

/**
 * Build thumbnails for every set that is listed somewhere, so pages never wait on the CDN.
 * Runs a few downloads at a time; already cached sets are skipped.
 */
export async function warmThumbnails(concurrency = 4): Promise<{ built: number; failed: number; cached: number }> {
  const sets = (
    db.prepare('SELECT DISTINCT set_number AS n FROM listings').all() as { n: string }[]
  ).map((r) => r.n);
  const todo = sets.filter((n) => !WIDTHS.every((w) => existsSync(pathFor(n, w))));
  let built = 0;
  let failed = 0;
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let n = queue.shift(); n; n = queue.shift()) {
        try {
          await build(n);
          built++;
        } catch {
          failed++;
        }
      }
    }),
  );
  return { built, failed, cached: sets.length - todo.length };
}
