import type { Sql } from "@medveris/db";
import { errorFields, logEvent, metric } from "@medveris/platform";

/**
 * Lightweight auth-anomaly flagging, run from the jobs cycle.
 *
 * Reads only aggregate counts from the hash-chained audit log (no identifiers, no patient
 * data) and emits a structured `security_anomaly` warning when short-window thresholds are
 * exceeded. This is a telemetry signal for operators, not an enforcement point — the rate
 * limiter and authentication logic remain authoritative. Failures are isolated: a broken
 * scan never interrupts outbox relay, checkpointing or clinical operations.
 */

export interface SecurityAnomalyResult {
  flagged: boolean;
  deniedAuthEvents: number;
  emergencyOverrides: number;
  thresholdBreached: string[];
  error: string | null;
}

const SCAN_INTERVAL_MS = 5 * 60_000;
const WINDOW_MINUTES = 15;
const DENIED_AUTH_THRESHOLD = 25;
const EMERGENCY_OVERRIDE_THRESHOLD = 3;
let lastScan = 0;

export async function maybeFlagSecurityAnomaly(sql: Sql): Promise<SecurityAnomalyResult | null> {
  if (Date.now() - lastScan < SCAN_INTERVAL_MS) return null;
  lastScan = Date.now();
  try {
    const rows = await sql`
      select
        count(*) filter (where decision = 'deny' and action in ('auth.login', 'auth.mfa.email-code.verify', 'auth.mfa.recovery-code.use', 'auth.password.reset'))::int as denied_auth,
        count(*) filter (where action = 'emergency.override.create')::int as emergency_overrides
      from audit_events
      where occurred_at > now() - make_interval(mins => ${WINDOW_MINUTES})
    `;
    const deniedAuth = Number(rows[0]?.deniedAuth ?? 0);
    const emergencyOverrides = Number(rows[0]?.emergencyOverrides ?? 0);
    const thresholdBreached: string[] = [];
    if (deniedAuth >= DENIED_AUTH_THRESHOLD) thresholdBreached.push("denied_auth_threshold");
    if (emergencyOverrides >= EMERGENCY_OVERRIDE_THRESHOLD) thresholdBreached.push("emergency_override_threshold");
    const flagged = thresholdBreached.length > 0;
    if (flagged) {
      logEvent("warn", "security_anomaly", {
        windowMinutes: WINDOW_MINUTES,
        deniedAuthEvents: deniedAuth,
        emergencyOverrides,
        thresholdBreached,
      });
      metric("jobs.security_anomaly", 1, { thresholds: thresholdBreached.join(",") });
    }
    return { flagged, deniedAuthEvents: deniedAuth, emergencyOverrides, thresholdBreached, error: null };
  } catch (error) {
    logEvent("error", "security_anomaly_scan_failed", errorFields(error, false));
    return { flagged: false, deniedAuthEvents: 0, emergencyOverrides: 0, thresholdBreached: [], error: (error as Error).message };
  }
}
