import { useEffect, useState, type FormEvent } from "react";
import { Badge, Button, Card, Dialog, EmptyState, ErrorState, Field, Input, LoadingState, Notice, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import type { ActiveEmergencyOverride, EmergencyOverrideRecord } from "../lib/types";

/**
 * Break-the-glass access to a patient's signed records held by other facilities.
 *
 * This panel is only an affordance: the API requires an eligible clinical role, a verified MFA
 * session, password + TOTP reauthentication and a documented reason, and audits every read.
 */
const STORAGE_PREFIX = "mv:emergency-override:";

function storageKey(encounterId: string, userId: string): string {
  return `${STORAGE_PREFIX}${userId}:${encounterId}`;
}

function readStoredOverride(encounterId: string, userId: string): ActiveEmergencyOverride | null {
  try {
    const raw = sessionStorage.getItem(storageKey(encounterId, userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveEmergencyOverride>;
    if (typeof parsed.id !== "string" || typeof parsed.expiresAt !== "string") return null;
    if (new Date(parsed.expiresAt).getTime() <= Date.now()) return null;
    return { id: parsed.id, expiresAt: parsed.expiresAt, reviewStatus: parsed.reviewStatus ?? "pending" };
  } catch {
    return null;
  }
}

export function EmergencyAccessPanel({ patientId, encounterId }: { patientId: string; encounterId: string }) {
  const { me } = useAuth();
  const userId = me?.user.id ?? "anonymous";
  const [active, setActive] = useState<ActiveEmergencyOverride | null>(() => readStoredOverride(encounterId, userId));
  const [requestOpen, setRequestOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const action = useAction();

  useEffect(() => {
    if (active) {
      try {
        sessionStorage.setItem(storageKey(encounterId, userId), JSON.stringify(active));
      } catch {
        // Session storage is optional; the override remains usable for this page view.
      }
    } else {
      try {
        sessionStorage.removeItem(storageKey(encounterId, userId));
      } catch {
        // Ignore unavailable storage.
      }
    }
  }, [active, encounterId, userId]);

  // Stop presenting projected records as soon as the time-boxed access window closes.
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [active]);

  const roles = me?.activeTenant?.roles ?? [];
  const eligibleRole = roles.includes("clinician") || roles.includes("nurse");
  const eligible = eligibleRole && Boolean(me?.user.mfaEnrolled && me.user.mfaVerified);

  const expired = active ? new Date(active.expiresAt).getTime() <= now : false;
  const records = useQuery<{ records: EmergencyOverrideRecord[] }>(
    active && !expired ? `/emergency-overrides/${active.id}/records` : null,
  );

  async function revoke(reason: string) {
    if (!active) return;
    const ok = await action.run("revoke", async () => {
      await api(`/emergency-overrides/${active.id}/revoke`, { method: "POST", body: { reason } });
      setActive(null);
      setRevokeOpen(false);
      return "Emergency access ended. Client sessions must reauthenticate to open it again.";
    });
    if (!ok) setRevokeOpen(false);
  }

  if (!eligible) {
    return (
      <Card title="Emergency cross-facility access" description="Break-the-glass is restricted to clinical staff with verified two-step verification.">
        <Notice tone="info">
          This action requires a clinician or nursing role on a verified facility session. Facility administration does not
          grant clinical access.
        </Notice>
      </Card>
    );
  }

  return (
    <Card
      title="Emergency cross-facility access"
      description="Break-the-glass opens another facility's signed notes for this patient when treatment cannot wait. Every view is audited and shown in the patient's access history."
      actions={
        active && !expired ? (
          <div className="mv-row">
            <Button variant="secondary" size="sm" onClick={records.reload} busy={records.loading}>Refresh records</Button>
            <Button variant="danger" size="sm" onClick={() => setRevokeOpen(true)}>End access</Button>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setRequestOpen(true)}>Start emergency access</Button>
        )
      }
    >
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}

      {!active ? (
        <div className="mv-stack">
          <Notice tone="warning" title="Use only when care cannot wait">
            Record the clinical justification, then reauthenticate with your password and authenticator code. Access expires
            automatically, the patient is notified afterwards and facility governance reviews the use.
          </Notice>
        </div>
      ) : (
        <div className="mv-stack">
          <div className="mv-spread">
            <div>
              <strong>Emergency access is {expired ? "closed" : "active"}</strong>
              <div className="mv-small mv-muted">
                Expires {formatDateTime(active.expiresAt)} · patient-visible in their access history
              </div>
            </div>
            <Badge tone={expired ? "neutral" : "warning"}>{expired ? "expired" : "active"}</Badge>
          </div>
          {expired ? (
            <Notice tone="info">Access has expired and projected records are no longer shown. Start a new emergency access only if care still requires it.</Notice>
          ) : records.loading ? <LoadingState label="Opening permitted records" /> : records.error ? <ErrorState message={records.error} onRetry={records.reload} /> : !records.data?.records.length ? (
            <EmptyState
              title="No records are available through this override"
              description="This patient has no signed records at another facility, or sensitive categories are excluded from emergency projection. Access still expires and stays audited."
            />
          ) : (
            <div className="mv-stack">
              <div className="mv-small mv-muted">{records.data.records.length} record(s) from other facilities. Source ownership is unchanged; nothing here is editable.</div>
              {records.data.records.map((record) => (
                <article key={`${record.category}-${record.resourceId}`} className="mv-note">
                  <div className="mv-spread">
                    <strong>{record.title || record.category}</strong>
                    <div className="mv-row">
                      <Badge tone="info">{record.category}</Badge>
                      <Badge tone="neutral">{record.status}</Badge>
                    </div>
                  </div>
                  <div className="mv-small mv-muted">
                    {record.sourceFacility} · {record.authorName} · clinical {formatDateTime(record.occurredAt)}
                  </div>
                  {record.summary ? <p className="mv-pre" style={{ marginTop: 6 }}>{record.summary}</p> : null}
                </article>
              ))}
            </div>
          )}
        </div>
      )}

      <RequestDialog
        open={requestOpen}
        busy={action.busy === "request"}
        error={requestOpen ? action.error : null}
        onClose={() => { setRequestOpen(false); action.reset(); }}
        onCreate={async (body) => {
          const ok = await action.run("request", async () => {
            const response = await api<{ override: ActiveEmergencyOverride }>(`/patients/${patientId}/emergency-overrides`, {
              method: "POST",
              body: { ...body, patientId, encounterId },
            });
            setActive(response.override);
            setRequestOpen(false);
            return "Emergency access granted. It expires automatically and is queued for governance review.";
          });
          if (ok) setRequestOpen(false);
        }}
      />

      <RevokeDialog
        open={revokeOpen}
        busy={action.busy === "revoke"}
        onClose={() => setRevokeOpen(false)}
        onRevoke={(reason) => void revoke(reason)}
      />
    </Card>
  );
}

function RequestDialog({ open, busy, error, onClose, onCreate }: {
  open: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (body: { reason: string; password: string; totpCode: string }) => void;
}) {
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const validCode = /^\d{6}$/.test(totpCode);
  const canSubmit = reason.trim().length >= 10 && password.length > 0 && validCode && !busy;

  useEffect(() => {
    if (!open) {
      setReason("");
      setPassword("");
      setTotpCode("");
    }
  }, [open]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    onCreate({ reason: reason.trim(), password, totpCode });
  }

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      title="Start emergency access"
      description="Break-the-glass requires a documented reason and fresh reauthentication. It cannot be used silently."
    >
      {error ? <ErrorState message={error} /> : null}
      <form className="mv-stack" onSubmit={submit}>
        <Field label="Clinical justification" htmlFor="break-glass-reason" hint="At least 10 characters. Explain why care cannot wait for consent.">
          <Textarea
            id="break-glass-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
            minLength={10}
            maxLength={2000}
            autoFocus placeholder="Enter the reason" />
        </Field>
        <Field label="Your password" htmlFor="break-glass-password">
          <Input
            id="break-glass-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required placeholder="Enter your password" />
        </Field>
        <Field label="Authenticator code" htmlFor="break-glass-totp" hint="Six digits from your authenticator app.">
          <Input
            id="break-glass-totp"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={totpCode}
            onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            required placeholder="Enter 6-digit code" />
        </Field>
        <Notice tone="warning">The patient will see this access in their access history, and governance will review it.</Notice>
        <Button type="submit" variant="danger" disabled={!canSubmit} busy={busy}>
          {busy ? "Verifying…" : "Grant emergency access"}
        </Button>
      </form>
    </Dialog>
  );
}

function RevokeDialog({ open, busy, onClose, onRevoke }: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onRevoke: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (!open) setReason("");
  }, [open]);

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      title="End emergency access"
      description="Record why the override is being closed. This is audited and ends access immediately."
    >
      <form
        className="mv-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (reason.trim().length >= 5) onRevoke(reason.trim());
        }}
      >
        <Field label="Reason for ending access" htmlFor="break-glass-revoke-reason" hint="At least 5 characters.">
          <Textarea
            id="break-glass-revoke-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
            minLength={5}
            maxLength={2000} placeholder="Enter the reason" />
        </Field>
        <Button type="submit" variant="danger" disabled={busy || reason.trim().length < 5} busy={busy}>
          {busy ? "Ending…" : "End access now"}
        </Button>
      </form>
    </Dialog>
  );
}
