import { useCallback, useState } from "react";
import { errorMessage } from "./api";

export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const run = useCallback(async (key: string, action: () => Promise<string | void>) => {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      const result = await action();
      if (result) setMessage(result);
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  const reset = useCallback(() => {
    setError(null);
    setMessage(null);
  }, []);

  return { busy, error, message, run, reset, setError, setMessage };
}
