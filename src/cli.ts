import { db } from './db.js';
import { importCatalog } from './catalog.js';
import { importGeoPincodes } from './geo.js';
import { warmThumbnails } from './images.js';
import { ensurePincode } from './pincodes.js';
import { runScrape } from './scrape.js';
import { latestPrices } from './queries.js';
import { cleanTitle, isBundle, looksNotGenuine } from './match.js';

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

switch (cmd) {
  case 'geo':
    console.log('importing pincode coordinates from GeoNames...');
    console.log(await importGeoPincodes());
    break;

  case 'images': {
    console.log('building thumbnails for every listed set...');
    console.log(await warmThumbnails(Number(flag('concurrency') ?? 6)));
    break;
  }

  case 'catalog':
    console.log('importing LEGO catalog from Rebrickable...');
    console.log(await importCatalog());
    break;

  case 'pincode': {
    const [sub, ...pins] = args;
    if (sub === 'add' && pins.length) {
      for (const p of pins) console.log(await ensurePincode(p));
    } else if (sub === 'list') {
      console.table(db.prepare('SELECT * FROM pincodes ORDER BY pincode').all());
    } else {
      console.log('usage: cli pincode add <pincode...> | cli pincode list');
    }
    break;
  }

  case 'scrape':
    await runScrape({ platform: flag('platform'), pincode: flag('pincode'), force: true });
    break;

  case 'prices': {
    const [set, pincode] = args;
    if (!set || !pincode) {
      console.error('usage: cli prices <setNumber> <pincode>');
      process.exit(1);
    }
    const rows = latestPrices(set, pincode);
    if (rows.length === 0) console.log('no prices stored for that set and pincode yet');
    else console.table(rows);
    break;
  }

  case 'clean': {
    // Apply the current "genuine LEGO only" rules to what is already stored.
    const rows = db.prepare('SELECT id, title, brand FROM listings').all() as { id: number; title: string; brand: string | null }[];
    const dry = args.includes('--dry-run');
    let retitled = 0;
    const doomed: { id: number; title: string }[] = [];
    const setTitle = db.prepare('UPDATE listings SET title = ? WHERE id = ?');
    for (const r of rows) {
      const brandBad = r.brand != null && r.brand.trim() !== '' && r.brand.replace(/[^\p{L}]/gu, '').toLowerCase() !== 'lego';
      if (looksNotGenuine(r.title) || isBundle(r.title) || brandBad) doomed.push({ id: r.id, title: r.title });
      else if (cleanTitle(r.title) !== r.title) {
        retitled++;
        if (!dry) setTitle.run(cleanTitle(r.title), r.id);
      }
    }
    for (const d of doomed.slice(0, 20)) console.log('not genuine:', d.title.slice(0, 100));
    if (!dry && doomed.length) {
      const delPrices = db.prepare('DELETE FROM prices WHERE listing_id = ?');
      const delListing = db.prepare('DELETE FROM listings WHERE id = ?');
      db.transaction(() => {
        for (const d of doomed) {
          delPrices.run(d.id);
          delListing.run(d.id);
        }
      })();
    }
    console.log(`${dry ? '[dry run] ' : ''}listings checked: ${rows.length} | titles tidied: ${retitled} | not genuine ${dry ? 'found' : 'removed'}: ${doomed.length}`);
    break;
  }

  case 'unmatched':
    console.table(db.prepare('SELECT platform, title FROM unmatched ORDER BY seen_at DESC LIMIT 100').all());
    break;

  default:
    console.log(
      [
        'commands:',
        '  catalog                       import the full LEGO set catalog (run first)',
        '  geo                           import coordinates for every Indian pincode',
        '  images                        build small cached thumbnails for every listed set',
        '  pincode add <pincode...>      resolve and store pincodes to track',
        '  pincode list',
        '  scrape [--platform id] [--pincode pin]',
        '  prices <setNumber> <pincode>',
        '  clean [--dry-run]             apply the genuine-LEGO-only rules to stored data',
        '  unmatched                     LEGO-looking products not tied to a catalog set',
      ].join('\n'),
    );
}
