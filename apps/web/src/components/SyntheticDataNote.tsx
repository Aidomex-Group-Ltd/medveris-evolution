import { useAppEnvironment } from "../lib/environment";

/** States that the environment holds synthetic data; renders nothing in production. */
export function SyntheticDataNote() {
  const { synthetic } = useAppEnvironment();
  return synthetic ? <p className="mv-small">Synthetic data only in this environment.</p> : null;
}
