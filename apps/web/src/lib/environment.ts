import { useEffect, useState } from "react";
import { api } from "./api";
import type { PublicConfig } from "./types";

export interface AppEnvironment {
  /** The server's APP_ENV, or null until /public/config answers. */
  appEnv: string | null;
  /** The environment holds synthetic demonstration data. False until known, so demo content never shows by default. */
  synthetic: boolean;
  /** Local development or tests, the only environments where development sign-in helpers can be enabled. */
  local: boolean;
}

const LOCAL_ENVIRONMENTS = new Set(["development", "test"]);

let request: Promise<PublicConfig> | null = null;

function publicConfig(): Promise<PublicConfig> {
  request ??= api<PublicConfig>("/public/config").catch((error: unknown) => {
    request = null;
    throw error;
  });
  return request;
}

export function describeEnvironment(appEnv: string | null): AppEnvironment {
  return {
    appEnv,
    synthetic: appEnv !== null && appEnv !== "production",
    local: appEnv !== null && LOCAL_ENVIRONMENTS.has(appEnv),
  };
}

export function useAppEnvironment(): AppEnvironment {
  const [appEnv, setAppEnv] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    publicConfig()
      .then((config) => {
        if (active) setAppEnv(config.appEnv);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return describeEnvironment(appEnv);
}
