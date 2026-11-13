import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, Card, ErrorState, LoadingState, Notice } from "@medveris/ui";
import { api, errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useQuery } from "../lib/useQuery";
import { BrandMark } from "./BrandMark";

interface LegalDocumentSummary {
  kind: "terms" | "privacy";
  version: string;
  title: string;
  effectiveAt: string;
  digest: string;
  accepted: boolean;
}

interface LegalAcceptanceStatus {
  current: LegalDocumentSummary[];
  requiresAcceptance: boolean;
  reviewNotice: string;
  notice: string;
}

const formatEffective = (value: string) => new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

/**
 * Blocking re-acceptance screen shown when a release bundles Terms or Privacy versions this account
 * has not accepted yet. Consent records are append-only, so accepting here can never overwrite the
 * original registration acceptance history.
 */
export function LegalReacceptance() {
  const { refresh, logout } = useAuth();
  const { data, loading, error, reload } = useQuery<LegalAcceptanceStatus>("/me/legal");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const terms = data?.current.find((document) => document.kind === "terms");
  const privacy = data?.current.find((document) => document.kind === "privacy");
  const outstanding = data?.current.filter((document) => !document.accepted) ?? [];

  async function accept(event: FormEvent) {
    event.preventDefault();
    if (!terms || !privacy || !data) return;
    setBusy(true);
    setFailure(null);
    try {
      await api("/me/legal/accept", {
        method: "POST",
        body: {
          termsVersion: terms.version,
          privacyVersion: privacy.version,
          termsAccepted: true,
          privacyAcknowledged: true,
        },
      });
      await refresh();
    } catch (cause) {
      setFailure(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mv-authx">
      <div className="mv-authx__card" style={{ maxWidth: 720, margin: "0 auto" }}>
          <Link to="/" className="mv-authx__brand" aria-label="Medveris home">
            <BrandMark />
            <span className="mv-authx__wordmark">Medveris</span>
          </Link>
          <form className="mv-stack" onSubmit={accept}>
            <Card
              title="Updated legal documents"
              description="This release bundles versions of the Terms of Service and Privacy Notice that your account has not accepted yet. Review and accept them to continue. This is separate from marketing, cookie and clinical consent."
            >
              {loading && !data ? <LoadingState label="Loading the current documents" /> : null}
              {error ? <ErrorState message={error} onRetry={reload} /> : null}
              {failure ? <ErrorState message={failure} /> : null}
              {outstanding.map((document) => (
                <Notice key={document.kind} tone="info" title={`${document.title} — version ${document.version}`}>
                  Effective {formatEffective(document.effectiveAt)} · Digest <span className="mv-id">{document.digest.slice(0, 16)}…</span><br />
                  <Link to={document.kind === "terms" ? "/terms" : "/privacy"} target="_blank" rel="noreferrer">Read the full {document.kind === "terms" ? "Terms of Service" : "Privacy Notice"}</Link>
                </Notice>
              ))}
              {data?.reviewNotice ? <p className="mv-small mv-muted">{data.reviewNotice}</p> : null}
              <Button type="submit" disabled={busy || !data}>{busy ? "Recording your acceptance…" : "Accept the Terms and acknowledge the Privacy Notice"}</Button>
              <Button type="button" variant="ghost" onClick={() => void logout()}>Sign out</Button>
            </Card>
          </form>
      </div>
    </div>
  );
}
