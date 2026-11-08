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
  /** The server serves local-development authenticator codes. False until known, so no helper is offered by default. */
  devTotpCodes: boolean;
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

export function describeEnvironment(appEnv: string | null, devTotpCodes = false): AppEnvironment {
  return {
    appEnv,
    synthetic: appEnv !== null && appEnv !== "production",
    local: appEnv !== null && LOCAL_ENVIRONMENTS.has(appEnv),
    devTotpCodes: appEnv !== null && appEnv !== "production" && devTotpCodes,
  };
}

export function useAppEnvironment(): AppEnvironment {
  const [state, setState] = useState<{ appEnv: string | null; devTotpCodes: boolean }>({ appEnv: null, devTotpCodes: false });
  useEffect(() => {
    let active = true;
    publicConfig()
      .then((config) => {
        if (active) setState({ appEnv: config.appEnv, devTotpCodes: config.devTotpCodes === true });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return describeEnvironment(state.appEnv, state.devTotpCodes);
}
