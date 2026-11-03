import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";

interface QueryState<T> {
  data: T | null;
  loading: boolean;
  /** Friendly, already-formatted text for simple surfaces. */
  error: string | null;
  /** The original thrown value so callers can render a fully mapped friendly error. */
  cause: unknown;
  reload: () => void;
}

export function useQuery<T>(path: string | null, options: { enabled?: boolean } = {}): QueryState<T> {
  const enabled = options.enabled ?? true;
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null; cause: unknown }>({ data: null, loading: Boolean(path && enabled), error: null, cause: null });
  const generation = useRef(0);

  useEffect(() => {
    if (!path || !enabled) {
      setState({ data: null, loading: false, error: null, cause: null });
      return;
    }
    const current = ++generation.current;
    const controller = new AbortController();
    setState((s) => ({ data: s.data, loading: true, error: null, cause: null }));
    api<T>(path, { signal: controller.signal })
      .then((data) => {
        if (current === generation.current) setState({ data, loading: false, error: null, cause: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || current !== generation.current) return;
        setState({ data: null, loading: false, error: errorMessage(error), cause: error });
      });
    return () => controller.abort();
  }, [path, enabled, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { ...state, reload };
}
