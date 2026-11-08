import { Card, ErrorState, LoadingState, Notice, PageHeader } from "@medveris/ui";
import { PublicSiteLayout } from "../components/PublicSiteLayout";
import { api } from "../lib/api";
import { useQuery } from "../lib/useQuery";

interface LegalSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
}

interface LegalDocument {
  kind: "terms" | "privacy";
  version: string;
  title: string;
  effectiveAt: string;
  reviewStatus: "counsel-review-required" | "counsel-reviewed";
  summary: string;
  sections: LegalSection[];
  digest: string;
  reviewNotice: string;
}

const formatEffective = (value: string) => new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

/**
 * Public Terms/Privacy page. It needs no session and reads only the published version metadata and
 * the body bundled with this release; no account, clinical or payment data is fetched.
 */
function LegalDocumentPage({ kind }: { kind: "terms" | "privacy" }) {
  const { data, loading, error, reload } = useQuery<LegalDocument>(`/public/legal/${kind}`);
  return (
    <PublicSiteLayout>
      <div className="mv-stack">
        <PageHeader
          eyebrow="Legal"
          title={data?.title ?? (kind === "terms" ? "Terms of Service" : "Privacy Notice")}
          description={data?.summary ?? "The published version for this deployment."}
        />
        {loading && !data ? <LoadingState label="Loading the published document" /> : null}
        {error ? <ErrorState message={error} onRetry={reload} /> : null}
        {data ? (
          <div className="mv-stack">
            <Notice tone="warning" title="Review status">
              {data.reviewNotice}
            </Notice>
            <p className="mv-small mv-muted">
              Version <strong>{data.version}</strong> · Effective {formatEffective(data.effectiveAt)} · Document digest <code>{data.digest.slice(0, 16)}…</code>
            </p>
            {data.sections.map((section) => (
              <Card key={section.heading} title={section.heading}>
                {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                {section.bullets ? (
                  <ul>
                    {section.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
                  </ul>
                ) : null}
              </Card>
            ))}
          </div>
        ) : null}
      </div>
    </PublicSiteLayout>
  );
}

export function TermsPage() {
  return <LegalDocumentPage kind="terms" />;
}

export function PrivacyPage() {
  return <LegalDocumentPage kind="privacy" />;
}
