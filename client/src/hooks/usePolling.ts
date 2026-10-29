import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Loads data now and every intervalMs; refresh() reloads on demand (e.g. after an action).
 * Skips a tick while a request is still running (so slow replies can't land out of order) and
 * pauses while the tab is hidden. `error` stays set while data is stale, so callers can say so.
 */
export function usePolling<T>(load: () => Promise<T>, intervalMs = 4000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback((): Promise<void> => {
    // An explicit refresh while a poll is running waits for it, then loads again for fresh data
    const run = async () => {
      try {
        setData(await loadRef.current());
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    const next = (inFlight.current ?? Promise.resolve()).then(run);
    const tracked = next.finally(() => {
      if (inFlight.current === tracked) inFlight.current = null;
    });
    inFlight.current = tracked;
    return tracked;
  }, []);

  useEffect(() => {
    refresh();
    const tick = () => {
      if (document.hidden || inFlight.current) return;
      refresh();
    };
    const id = setInterval(tick, intervalMs);
    const onVisible = () => !document.hidden && tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, intervalMs]);

  return { data, error, refresh };
}
