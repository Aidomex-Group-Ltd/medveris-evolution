import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge, Button, Card, DataList, ErrorState, Field, Input, LoadingState, Notice, Select, Textarea } from "@medveris/ui";
import { api, errorMessage } from "../lib/api";
import { formatDate } from "../lib/format";
import { useQuery } from "../lib/useQuery";
import type { PublicFacility } from "./DirectoryPage";

interface DetailResponse {
  facility: PublicFacility;
  sponsor: { campaignId: string; surface: string; label: string; startsOn: string; endsOn: string } | null;
}

const REPORT_TYPES = ["abuse", "closed", "relocated", "location", "other"] as const;

function track(facility: PublicFacility, eventType: string) {
  void api("/public/directory/events", {
    method: "POST",
    body: { eventType, facilityPublicId: facility.publicId, campaignId: facility.promotion?.campaignId ?? null, surface: "detail" },
  }).catch(() => undefined);
}

export function DirectoryDetailPage() {
  const { publicId = "" } = useParams();
  const detail = useQuery<DetailResponse>(publicId ? `/public/directory/facilities/${encodeURIComponent(publicId)}` : null);
  const [reportType, setReportType] = useState<string>("location");
  const [detailText, setDetailText] = useState("");
  const [contact, setContact] = useState("");
  const [reportState, setReportState] = useState<{ busy: boolean; error: string | null; message: string | null }>({ busy: false, error: null, message: null });

  useEffect(() => {
    if (detail.data?.facility) track(detail.data.facility, "detail-open");
  }, [detail.data]);

  async function submitReport(event: FormEvent) {
    event.preventDefault();
    if (!detail.data) return;
    setReportState({ busy: true, error: null, message: null });
    try {
      await api(`/public/directory/reports?facility=${encodeURIComponent(detail.data.facility.publicId)}`, {
        method: "POST",
        body: { reportType, detail: detailText, contact },
      });
      setReportState({ busy: false, error: null, message: "Report received. Directory editors will review the listing." });
      setDetailText("");
    } catch (cause) {
      setReportState({ busy: false, error: errorMessage(cause), message: null });
    }
  }

  const facility = detail.data?.facility ?? null;
  const sponsor = detail.data?.sponsor ?? null;

  return (
    <div className="mv-public">
      <header className="mv-public__header">
        <Link to="/" className="mv-brand" aria-label="Medveris home"><span className="mv-brand__mark" aria-hidden="true">M</span><span>Medveris<small>Public provider directory</small></span></Link>
        <nav className="mv-row"><Link to="/directory">Back to search</Link><Link to="/login">Sign in</Link></nav>
      </header>
      <main className="mv-public__main mv-stack">
        {detail.loading ? <LoadingState label="Loading listing" /> : detail.error ? <ErrorState message={detail.error} onRetry={detail.reload} /> : !facility ? <Notice tone="warning">Listing not found.</Notice> : (
          <>
            <Card>
              <div className="mv-row mv-row--between">
                <div>
                  <p className="mv-eyebrow">{facility.facilityType.replaceAll("-", " ")}</p>
                  <h1>{facility.name}</h1>
                  <p className="mv-muted">{facility.branches.map((branch) => branch.city ?? (branch as any).locality).filter(Boolean).join(" · ") || facility.country}</p>
                </div>
                <div className="mv-row">
                  {sponsor ? <Badge tone="warning">{sponsor.label}</Badge> : null}
                  {facility.credentialStatus === "verified" ? <Badge tone="success">Credentials verified</Badge> : <Badge>Credentials not verified</Badge>}
                  {facility.claimed ? <Badge tone="info">Claimed by facility</Badge> : <Badge>Unclaimed</Badge>}
                </div>
              </div>
              {sponsor ? <Notice tone="warning" title="Sponsored placement">This facility paid for a labelled placement from {formatDate(sponsor.startsOn)} to {formatDate(sponsor.endsOn)}. Sponsored status does not change organic ranking, verification, capability evidence or emergency guidance.</Notice> : null}
              {facility.description ? <p>{facility.description}</p> : null}
              <DataList items={[
                { label: "Medveris participation", value: facility.medverisParticipation },
                { label: "Last confirmed", value: formatDate(facility.lastConfirmedOn) },
                { label: "Source", value: facility.claimed ? "Claimed and maintained by the facility" : "Public directory record" },
              ]} />
            </Card>

            <div className="mv-grid-2">
              <Card title="Branches and contact">
                <div className="mv-stack">
                  {facility.branches.map((branch) => (
                    <article key={branch.id} className="mv-directory-card">
                      <div className="mv-row mv-row--between"><strong>{branch.name}</strong>{branch.isPrimary ? <Badge tone="info">Primary</Badge> : null}</div>
                      <p className="mv-small mv-muted">{[branch.addressLine1, branch.city, (branch as any).district, (branch as any).country].filter(Boolean).join(", ")}</p>
                      <p className="mv-small">Coordinates: {branch.latitude != null && branch.longitude != null ? `${branch.latitude.toFixed(5)}, ${branch.longitude.toFixed(5)} (${branch.locationStatus})` : "Not published"}</p>
                      {Object.keys(branch.openingHours ?? {}).length ? (
                        <ul className="mv-small">{Object.entries(branch.openingHours).map(([day, hours]) => <li key={day}>{day}: {hours}</li>)}</ul>
                      ) : null}
                      <div className="mv-row mv-wrap">
                        {branch.latitude != null && branch.longitude != null ? (
                          <a className="mv-button mv-button--secondary mv-button--sm" href={`https://www.openstreetmap.org/?mlat=${branch.latitude}&mlon=${branch.longitude}#map=16/${branch.latitude}/${branch.longitude}`} target="_blank" rel="noreferrer" onClick={() => track(facility, "directions-click")}>Open map directions</a>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
                <div className="mv-row mv-wrap">
                  {facility.publicPhone ? <a className="mv-button mv-button--sm" href={`tel:${facility.publicPhone}`} onClick={() => track(facility, "contact-click")}>Call {facility.publicPhone}</a> : null}
                  {facility.publicEmail ? <a className="mv-button mv-button--secondary mv-button--sm" href={`mailto:${facility.publicEmail}`} onClick={() => track(facility, "contact-click")}>Email</a> : null}
                  {facility.website ? <a className="mv-button mv-button--secondary mv-button--sm" href={facility.website} target="_blank" rel="noreferrer">Website</a> : null}
                </div>
              </Card>
              <Card title="Services and documented capabilities">
                <h3 className="mv-small mv-muted">Services</h3>
                {facility.services.length ? <ul className="mv-stack">{facility.services.map((service) => <li key={service.id}><strong>{service.name}</strong><div className="mv-small mv-muted">{service.category.replaceAll("-", " ")}</div></li>)}</ul> : <p className="mv-muted">No services published.</p>}
                <h3 className="mv-small mv-muted">Capabilities</h3>
                {facility.capabilities.length ? <ul className="mv-stack">{facility.capabilities.map((capability) => <li key={capability.code} className="mv-row mv-row--between"><span>{capability.name}</span><Badge tone={capability.status === "verified" ? "success" : "neutral"}>{capability.status}</Badge></li>)}</ul> : <p className="mv-muted">No capabilities published.</p>}
              </Card>
            </div>

            <Card title="Report a problem with this listing" description="Reports are reviewed by directory editors. Do not include patient information.">
              {reportState.error ? <Notice tone="danger">{reportState.error}</Notice> : null}
              {reportState.message ? <Notice tone="success">{reportState.message}</Notice> : null}
              <form className="mv-form-grid" onSubmit={submitReport}>
                <Field label="Issue type">
                  <Select value={reportType} onChange={(event) => setReportType(event.target.value)}>{REPORT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</Select>
                </Field>
                <Field label="Contact (optional)">
                  <Input value={contact} onChange={(event) => setContact(event.target.value)} placeholder="Email or phone for follow-up" />
                </Field>
                <Field label="What is wrong?">
                  <Textarea required minLength={10} maxLength={2000} value={detailText} onChange={(event) => setDetailText(event.target.value)} />
                </Field>
                <Button type="submit" disabled={reportState.busy}>{reportState.busy ? "Sending…" : "Send report"}</Button>
              </form>
            </Card>
          </>
        )}
      </main>
      <footer className="mv-public__footer"><p>Straight-line distances only. In an emergency, contact local emergency services. Synthetic demonstration data.</p></footer>
    </div>
  );
}
