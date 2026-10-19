'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, post } from './api';
import type { Overview, RefreshJob, SetDetail } from './types';

/** Current time, re-read every `ms` so "3 min ago" labels stay honest. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** GET a JSON resource and re-read it on demand or on an interval. */
function useResource<T>(path: string | null, refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const current = useRef(path);
  current.current = path;

  const load = useCallback(
    async (quiet = false) => {
      if (!path) return;
      if (!quiet) setLoading(true);
      try {
        const d = await api<T>(path);
        if (current.current === path) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (current.current === path && !quiet) setError((e as Error).message);
      } finally {
        if (current.current === path) setLoading(false);
      }
    },
    [path],
  );

  useEffect(() => {
    setData(null);
    setError(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!refreshMs || !path) return;
    const t = setInterval(() => void load(true), refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs, path]);

  return { data, error, loading, reload: load };
}

/** Every set listed at a pincode. Quietly re-read every minute so the page stays live. */
export const useOverview = (pincode: string | null) =>
  useResource<Overview>(pincode ? `/api/sets?pincode=${pincode}` : null, 60_000);

export const useSetDetail = (setNumber: string, pincode: string | null) =>
  useResource<SetDetail>(pincode ? `/api/set/${encodeURIComponent(setNumber)}?pincode=${pincode}` : null, 60_000);

/**
 * "Fetch live rates". Queues a refresh of every store for the pincode, then follows its progress.
 * Calls `onProgress` whenever another store finishes, so the page can show new prices as they land.
 */
export function useLiveRefresh(pincode: string | null, onProgress: () => void) {
  const [job, setJob] = useState<RefreshJob | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const finished = useRef(0);
  const cb = useRef(onProgress);
  cb.current = onProgress;

  // Pick up a refresh already in flight for this pincode (another tab, or a page reload).
  useEffect(() => {
    setJob(null);
    setNotice(null);
    setError(null);
    if (!pincode) return;
    api<{ job: RefreshJob | null }>(`/api/refresh?pincode=${pincode}`)
      .then(({ job }) => setJob(job))
      .catch(() => {});
  }, [pincode]);

  const active = job?.status === 'queued' || job?.status === 'running';

  useEffect(() => {
    if (!job || !active) return;
    const t = setInterval(async () => {
      try {
        const { job: next } = await api<{ job: RefreshJob }>(`/api/refresh/${job.id}`);
        const done = Object.values(next.progress).filter((p) => p.state !== 'queued' && p.state !== 'running').length;
        if (done !== finished.current) {
          finished.current = done;
          cb.current();
        }
        setJob(next);
      } catch {
        /* keep polling; a single failed poll is not worth surfacing */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [job?.id, active]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = useCallback(async () => {
    if (!pincode) return;
    setError(null);
    setNotice(null);
    try {
      const res = await post<{ job: RefreshJob; created: boolean; cooldownMs: number }>('/api/refresh', { pincode });
      finished.current = 0;
      setJob(res.job);
      if (!res.created && res.job.status === 'done' && res.job.finishedAt) {
        const wait = Math.max(0, Math.ceil((Date.parse(res.job.finishedAt) + res.cooldownMs - Date.now()) / 60_000));
        setNotice(`Prices were refreshed moments ago. You can fetch again in ${wait || 1} min.`);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [pincode]);

  return { job, active, start, notice, error };
}
