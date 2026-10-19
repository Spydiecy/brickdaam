'use client';

import { ago } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { storeName } from '@/lib/stores';
import type { PlatformInfo, ProgressState, RefreshJob } from '@/lib/types';
import { StoreChip } from './StoreChip';

function StateLabel({ p }: { p: ProgressState }) {
  switch (p.state) {
    case 'queued':
      return <span className="state state--wait">Waiting</span>;
    case 'running':
      return (
        <span className="state state--run">
          <span className="spinner" aria-hidden="true" /> Checking
        </span>
      );
    case 'done':
      return <span className="state state--ok">{p.listings} sets</span>;
    case 'unserved':
      return <span className="state state--muted">Doesn’t deliver here</span>;
    case 'failed':
      return (
        <span className="state state--bad" title={p.error}>
          Couldn’t reach
        </span>
      );
  }
}

interface Props {
  platforms: PlatformInfo[];
  job: RefreshJob | null;
  active: boolean;
  onStart: () => void;
  notice: string | null;
  error: string | null;
}

/** The "Fetch live rates" card: last-checked times per store, and live progress during a refresh. */
export function LiveRefresh({ platforms, job, active, onStart, notice, error }: Props) {
  const now = useNow(active ? 5000 : 30_000);
  const showJob = job && (active || (job.finishedAt && now - Date.parse(job.finishedAt) < 10 * 60_000));
  const entries = showJob ? Object.entries(job.progress) : null;
  const doneCount = entries?.filter(([, p]) => p.state !== 'queued' && p.state !== 'running').length ?? 0;
  const newest = platforms.reduce<string | null>((m, p) => (!m || p.lastChecked > m ? p.lastChecked : m), null);

  return (
    <section className="live" aria-labelledby="live-title">
      <div className="live-head">
        <div>
          <h2 id="live-title" className="live-title">
            {active ? 'Fetching live rates…' : 'Live rates'}
          </h2>
          <p className="live-sub">
            {active
              ? `${doneCount} of ${entries?.length ?? 0} stores checked`
              : newest
                ? `Latest check ${ago(newest, now)}. Stores refresh on their own every 5 to 30 min.`
                : 'No prices yet for this pincode.'}
          </p>
        </div>
        <button className="btn btn--dark btn--lg" type="button" onClick={onStart} disabled={active}>
          {active ? (
            <>
              <span className="spinner spinner--light" aria-hidden="true" /> Checking stores
            </>
          ) : (
            'Fetch live rates'
          )}
        </button>
      </div>

      {active && (
        <div
          className="live-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={entries?.length ?? 0}
          aria-valuenow={doneCount}
          aria-label="Stores checked"
        >
          <span style={{ width: `${entries?.length ? (doneCount / entries.length) * 100 : 0}%` }} />
        </div>
      )}

      <ul className="live-list" aria-live="polite">
        {entries
          ? entries.map(([id, p]) => (
              <li key={id}>
                <StoreChip id={id} size="sm" />
                <StateLabel p={p} />
              </li>
            ))
          : platforms.map((p) => {
              const stale = now - Date.parse(p.lastChecked) > p.staleAfterMin * 60_000;
              return (
                <li key={p.id}>
                  <StoreChip id={p.id} size="sm" />
                  <span className={`state ${stale ? 'state--stale' : 'state--muted'}`}>{ago(p.lastChecked, now)}</span>
                </li>
              );
            })}
      </ul>

      {job?.status === 'failed' && !active && (
        <p className="live-msg live-msg--bad">The last refresh stopped early: {job.error}</p>
      )}
      {notice && <p className="live-msg">{notice}</p>}
      {error && (
        <p className="live-msg live-msg--bad" role="alert">
          {error}
        </p>
      )}
      {showJob && !active && job.status === 'done' && (() => {
        const failed = Object.entries(job.progress)
          .filter(([, p]) => p.state === 'failed')
          .map(([id]) => storeName(id));
        return (
          <p className="live-msg">
            {failed.length
              ? `Done. Couldn’t reach ${failed.join(', ')} this time; their previous prices stay up.`
              : `Done. All ${Object.keys(job.progress).length} stores updated.`}
          </p>
        );
      })()}
    </section>
  );
}
