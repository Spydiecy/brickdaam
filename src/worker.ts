import cron from 'node-cron';
import { runScrape } from './scrape.js';
import { closeBrowser } from './browser.js';
import { claimNextJob, failOrphanedJobs, finishJob, updateProgress } from './jobs.js';
import { warmThumbnails } from './images.js';

/**
 * Lanes, each with its own "already running" guard so a slow crawl never delays another:
 *  - fast: quick-commerce apps (Blinkit, Zepto, Ozi) every 5 minutes
 *  - slow: heavy sites (Amazon, Flipkart, FirstCry, BigBasket, Instamart) checked every 10 minutes;
 *    each platform only re-crawls a pincode once its own minIntervalMin has passed
 *  - live: "Fetch live rates" requests from the website, picked up within a few seconds
 */
const LANES = [
  {
    name: 'fast',
    schedule: process.env.SCRAPE_CRON ?? '*/5 * * * *',
    timeoutMs: Number(process.env.RUN_TIMEOUT_MS ?? 4 * 60_000),
  },
  {
    name: 'slow',
    schedule: process.env.SLOW_SCRAPE_CRON ?? '*/10 * * * *',
    timeoutMs: Number(process.env.SLOW_RUN_TIMEOUT_MS ?? 25 * 60_000),
  },
] as const;

const LIVE_POLL_MS = 3000;
const LIVE_TIMEOUT_MS = Number(process.env.LIVE_RUN_TIMEOUT_MS ?? 25 * 60_000);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`run exceeded ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

for (const lane of LANES) {
  let running = false;

  const tick = async () => {
    if (running) {
      console.log(`[worker:${lane.name}] previous run still in progress, skipping this tick`);
      return;
    }
    running = true;
    try {
      await withTimeout(runScrape({ lane: lane.name, keepBrowserOpen: true }), lane.timeoutMs);
    } catch (err) {
      console.error(`[worker:${lane.name}] run failed:`, (err as Error).message);
      // A hung page would otherwise stall every later run; Chrome restarts on next use.
      await closeBrowser().catch(() => {});
    } finally {
      running = false;
    }
  };

  console.log(`[worker:${lane.name}] schedule: ${lane.schedule}`);
  cron.schedule(lane.schedule, () => void tick());
  if (process.env.RUN_ON_START !== '0') void tick();
}

// Live lane: one website-requested refresh at a time, every platform, intervals ignored.
const orphaned = failOrphanedJobs();
if (orphaned) console.log(`[worker:live] marked ${orphaned} refresh(es) interrupted by the last restart as failed`);
let liveBusy = false;
setInterval(async () => {
  if (liveBusy) return;
  const job = claimNextJob();
  if (!job) return;
  liveBusy = true;
  console.log(`[worker:live] refresh #${job.id} for ${job.pincode} started`);
  try {
    await withTimeout(
      runScrape({
        pincode: job.pincode,
        force: true,
        // Every store at once: they are different websites, so this does not hammer any one of them.
        concurrency: Number(process.env.LIVE_CONCURRENCY ?? 8),
        keepBrowserOpen: true,
        onProgress: (platform, p) => updateProgress(job.id, platform, p),
      }),
      LIVE_TIMEOUT_MS,
    );
    finishJob(job.id);
    console.log(`[worker:live] refresh #${job.id} done`);
  } catch (err) {
    finishJob(job.id, (err as Error).message);
    console.error(`[worker:live] refresh #${job.id} failed:`, (err as Error).message);
  } finally {
    liveBusy = false;
  }
}, LIVE_POLL_MS);
console.log('[worker:live] watching for "fetch live rates" requests');

// Keep set thumbnails cached as new sets show up in the stores (only missing ones are fetched).
let warming = false;
const warm = async () => {
  if (warming) return;
  warming = true;
  try {
    const r = await warmThumbnails(3);
    if (r.built || r.failed) console.log(`[worker:images] thumbnails built ${r.built}, failed ${r.failed}, cached ${r.cached}`);
  } catch (err) {
    console.error('[worker:images] failed:', (err as Error).message);
  } finally {
    warming = false;
  }
};
cron.schedule('*/15 * * * *', () => void warm());
setTimeout(() => void warm(), 60_000);
