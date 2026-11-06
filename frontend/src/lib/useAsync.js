import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Loads data with loading/error state and cancels stale requests.
 *
 * `load(signal)` must return a promise. It re-runs whenever `deps` change. `reload()`
 * re-fetches on demand (e.g. a "Try again" button or after a mutation).
 */
export function useAsync(load, deps) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load; // eslint-disable-line react-hooks/refs -- always call the latest closure

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- show the spinner while a new request starts
    setState((s) => ({ status: 'loading', data: s.data, error: null }));
    loadRef.current(controller.signal).then(
      (data) => !controller.signal.aborted && setState({ status: 'ready', data, error: null }),
      (error) => {
        if (controller.signal.aborted || error?.name === 'AbortError') return;
        setState({ status: 'error', data: null, error });
      },
    );
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are supplied by the caller
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload, loading: state.status === 'loading' };
}
