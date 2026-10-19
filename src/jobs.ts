import { db } from './db.js';
import { adapters } from './adapters/index.js';
import type { PlatformProgress } from './scrape.js';

/**
 * "Fetch live rates" from the website. The API process only writes a job row; the worker process
 * (which owns Chrome) picks it up within a few seconds and crawls every platform for that pincode,
 * ignoring the usual per-platform intervals. Progress is written back per platform so the website
 * can show which stores are done.
 */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface RefreshJob {
  id: number;
  pincode: string;
  status: JobStatus;
  progress: Record<string, PlatformProgress | { state: 'queued' }>;
  error: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** A forced refresh can not be requested more often than this per pincode. */
export const REFRESH_COOLDOWN_MS = 3 * 60_000;
/** A job "running" for longer than this is treated as abandoned (worker restarted mid-run). */
const STALE_RUNNING_MS = 30 * 60_000;

function toJob(r: any): RefreshJob {
  return {
    id: r.id,
    pincode: r.pincode,
    status: r.status,
    progress: JSON.parse(r.progress || '{}'),
    error: r.error,
    requestedAt: r.requested_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function getJob(id: number): RefreshJob | null {
  const r = db.prepare('SELECT * FROM refresh_jobs WHERE id = ?').get(id);
  return r ? toJob(r) : null;
}

export function latestJob(pincode: string): RefreshJob | null {
  const r = db.prepare('SELECT * FROM refresh_jobs WHERE pincode = ? ORDER BY id DESC LIMIT 1').get(pincode);
  return r ? toJob(r) : null;
}

/**
 * Queue a refresh for a pincode. Returns the existing job instead when one is already queued or
 * running, or when the last one finished within the cooldown (so repeated clicks can not hammer
 * the stores).
 */
export function requestRefresh(pincode: string): { job: RefreshJob; created: boolean } {
  const last = latestJob(pincode);
  if (last && (last.status === 'queued' || last.status === 'running')) return { job: last, created: false };
  // Cooldown only after a successful refresh; a failed one can be retried straight away.
  if (last?.status === 'done' && last.finishedAt && Date.now() - Date.parse(last.finishedAt) < REFRESH_COOLDOWN_MS) {
    return { job: last, created: false };
  }
  const progress = Object.fromEntries(adapters.map((a) => [a.id, { state: 'queued' }]));
  const { lastInsertRowid } = db
    .prepare('INSERT INTO refresh_jobs (pincode, progress) VALUES (?, ?)')
    .run(pincode, JSON.stringify(progress));
  return { job: getJob(Number(lastInsertRowid))!, created: true };
}

/**
 * Worker side, at startup: a job still marked "running" belonged to the previous worker process,
 * which is gone (restart or crash), so nothing will ever finish it. Fail it so the site stops
 * showing it as in progress and the button works again. Stores it had not reached are marked too.
 */
export function failOrphanedJobs(): number {
  const rows = db.prepare("SELECT * FROM refresh_jobs WHERE status = 'running'").all() as any[];
  for (const r of rows) {
    const job = toJob(r);
    for (const [id, p] of Object.entries(job.progress)) {
      if (p.state === 'queued' || p.state === 'running') {
        job.progress[id] = { state: 'failed', error: 'refresh interrupted by a tracker restart' };
      }
    }
    db.prepare(
      `UPDATE refresh_jobs SET status = 'failed', progress = ?, error = 'the tracker restarted during this refresh; start it again',
         finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    ).run(JSON.stringify(job.progress), job.id);
  }
  return rows.length;
}

/** Worker side: claim the oldest queued job, if any. */
export function claimNextJob(): RefreshJob | null {
  // Jobs left "running" by a worker that died are failed so they do not block new requests.
  db.prepare(
    `UPDATE refresh_jobs SET status = 'failed', error = 'worker restarted during the refresh',
       finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE status = 'running' AND started_at < ?`,
  ).run(new Date(Date.now() - STALE_RUNNING_MS).toISOString());

  return db.transaction(() => {
    const r = db.prepare("SELECT * FROM refresh_jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get() as any;
    if (!r) return null;
    db.prepare(
      "UPDATE refresh_jobs SET status = 'running', started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    ).run(r.id);
    return getJob(r.id);
  })();
}

export function updateProgress(id: number, platform: string, p: PlatformProgress) {
  const job = getJob(id);
  if (!job) return;
  job.progress[platform] = p;
  db.prepare('UPDATE refresh_jobs SET progress = ? WHERE id = ?').run(JSON.stringify(job.progress), id);
}

export function finishJob(id: number, error?: string) {
  db.prepare(
    `UPDATE refresh_jobs SET status = ?, error = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  ).run(error ? 'failed' : 'done', error ?? null, id);
}
