import { useState } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Notice, PageHeader, Table, Tabs } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDate, formatMoney } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

interface ModerationData {
  facilities: { id: string; publicId: string; name: string; facilityType: string; publicationStatus: string; credentialStatus: string; capabilityStatus: string; claimedTenantId: string | null; createdAt: string }[];
  claims: { id: string; facilityId: string; representativeName: string; roleTitle: string; authorityBasis: string; status: string; createdAt: string }[];
  reports: { id: string; facilityId: string; reportType: string; detail: string; reporterContact: string | null; status: string; createdAt: string; publicId: string; name: string }[];
  editRequests: { id: string; facilityId: string; requestedBy: string; payload: Record<string, unknown>; status: string; createdAt: string }[];
}

interface Campaign {
  id: string; facilityName: string; publicId: string; packageNameSnapshot: string; placementSurface: string;
  amountSnapshot: string | number; currencySnapshot: string; status: string; paymentStatus: string; editorialStatus: string;
  startsOn: string; endsOn: string;
}

interface Payment { id: string; status: string; provider: string; providerReference: string | null; amount: string | number; currency: string; createdAt: string }

export function DirectoryGovernancePage() {
  const [tab, setTab] = useState<"queue" | "reports" | "sponsorship">("queue");
  const moderation = useQuery<ModerationData>("/directory/moderation");
  const campaigns = useQuery<{ campaigns: Campaign[] }>("/promotions/campaigns");

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Platform operations" title="Directory and sponsorship governance" description="Editorial review, claim decisions, report resolution and sponsorship approval. Editorial approval is always separate from payment." />
      <Notice tone="info" title="Operator controls">Verification and sponsorship decisions are audited. Payment confirmation never substitutes for editorial review, and sponsorship never changes credential or capability status.</Notice>
      <Tabs label="Governance sections" value={tab} onChange={setTab} options={[
        { value: "queue", label: `Review queue${moderation.data ? ` (${moderation.data.facilities.length + moderation.data.claims.length})` : ""}` },
        { value: "reports", label: `Reports${moderation.data ? ` (${moderation.data.reports.length})` : ""}` },
        { value: "sponsorship", label: "Sponsorship" },
      ]} />
      {moderation.loading ? <LoadingState /> : moderation.error ? <ErrorState message={moderation.error} onRetry={moderation.reload} /> : moderation.data ? (
        tab === "queue" ? <Queue data={moderation.data} reload={moderation.reload} /> :
        tab === "reports" ? <Reports data={moderation.data} reload={moderation.reload} /> :
        <Sponsorship campaigns={campaigns.data?.campaigns ?? []} loading={campaigns.loading} error={campaigns.error} reload={campaigns.reload} />
      ) : null}
    </div>
  );
}

function Queue({ data, reload }: { data: ModerationData; reload: () => void }) {
  const action = useAction();
  const [claimReason, setClaimReason] = useState("Evidence of authority reviewed against submitted contact details");
  const [editReason, setEditReason] = useState("Profile change reviewed against source evidence");

  async function moderate(id: string, decision: "publish" | "suspend" | "archive" | "approve-profile") {
    const note = window.prompt("Moderation note (minimum 5 characters):", decision === "publish" ? "Profile and capabilities reviewed for publication" : "Updated after report review");
    if (!note || note.trim().length < 5) return;
    await action.run(`moderate-${id}`, async () => {
      await api(`/directory/facilities/${id}/moderation`, { method: "POST", body: { decision, note } });
      reload();
      return `Listing ${decision}.`;
    });
  }

  async function decideClaim(id: string, decision: "verify" | "reject") {
    await action.run(`claim-${id}`, async () => {
      await api(`/directory/claims/${id}/decision`, { method: "POST", body: { decision, reason: claimReason } });
      reload();
      return `Claim ${decision === "verify" ? "verified" : "rejected"}.`;
    });
  }

  async function decideEdit(id: string, decision: "approve" | "reject") {
    await action.run(`edit-${id}`, async () => {
      await api(`/directory/edit-requests/${id}/decision`, { method: "POST", body: { decision, reason: editReason } });
      reload();
      return `Edit request ${decision}d.`;
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <Notice tone="danger">{action.error}</Notice> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Facilities awaiting publication">
        {!data.facilities.length ? <EmptyState title="No pending facilities" description="New and updated listings appear here for review." /> : (
          <Table head={["Facility", "Status", "Verification", "Created", "Decision"]}>
            {data.facilities.map((facility) => (
              <tr key={facility.id}>
                <td><strong>{facility.name}</strong><div className="mv-small mv-muted">{facility.publicId} · {facility.facilityType.replaceAll("-", " ")}</div></td>
                <td><Badge tone="warning">{facility.publicationStatus}</Badge></td>
                <td className="mv-small">Credentials: {facility.credentialStatus}<div>Capabilities: {facility.capabilityStatus}</div></td>
                <td className="mv-small">{formatDate(facility.createdAt)}</td>
                <td><div className="mv-row mv-wrap"><Button size="sm" onClick={() => void moderate(facility.id, "publish")} disabled={Boolean(action.busy)}>Publish</Button><Button size="sm" variant="secondary" onClick={() => void moderate(facility.id, "approve-profile")} disabled={Boolean(action.busy)}>Approve profile</Button><Button size="sm" variant="danger" onClick={() => void moderate(facility.id, "archive")} disabled={Boolean(action.busy)}>Archive</Button></div></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Claims awaiting verification" description="Verifying a claim links the listing to the claimant organization and returns it to editorial review. It does not by itself verify credentials.">
        <label className="mv-field"><span className="mv-field__label">Claim decision reason</span><input className="mv-input" value={claimReason} onChange={(event) => setClaimReason(event.target.value)} /></label>
        {!data.claims.length ? <EmptyState title="No open claims" description="Submitted claims appear here." /> : (
          <Table head={["Representative", "Authority basis", "Submitted", "Decision"]}>
            {data.claims.map((claim) => (
              <tr key={claim.id}>
                <td><strong>{claim.representativeName}</strong><div className="mv-small mv-muted">{claim.roleTitle}</div></td>
                <td className="mv-small">{claim.authorityBasis}</td>
                <td className="mv-small">{formatDate(claim.createdAt)}</td>
                <td><div className="mv-row"><Button size="sm" onClick={() => void decideClaim(claim.id, "verify")} disabled={Boolean(action.busy)}>Verify claim</Button><Button size="sm" variant="danger" onClick={() => void decideClaim(claim.id, "reject")} disabled={Boolean(action.busy)}>Reject</Button></div></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Profile edit requests">
        <label className="mv-field"><span className="mv-field__label">Edit decision reason</span><input className="mv-input" value={editReason} onChange={(event) => setEditReason(event.target.value)} /></label>
        {!data.editRequests.length ? <EmptyState title="No edit requests" description="Provider edit requests appear here." /> : (
          <Table head={["Facility", "Payload", "Submitted", "Decision"]}>
            {data.editRequests.map((request) => (
              <tr key={request.id}>
                <td className="mv-small">{request.facilityId.slice(0, 8)}</td>
                <td className="mv-small"><code>{JSON.stringify(request.payload).slice(0, 240)}</code></td>
                <td className="mv-small">{formatDate(request.createdAt)}</td>
                <td><div className="mv-row"><Button size="sm" onClick={() => void decideEdit(request.id, "approve")} disabled={Boolean(action.busy)}>Approve</Button><Button size="sm" variant="danger" onClick={() => void decideEdit(request.id, "reject")} disabled={Boolean(action.busy)}>Reject</Button></div></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function Reports({ data, reload }: { data: ModerationData; reload: () => void }) {
  const action = useAction();

  async function resolve(id: string, decision: "resolved" | "dismissed") {
    const resolution = window.prompt("Resolution note (minimum 5 characters):", decision === "resolved" ? "Listing corrected or suspended after review" : "No inaccuracy found against current evidence");
    if (!resolution || resolution.trim().length < 5) return;
    await action.run(id, async () => {
      await api(`/directory/reports/${id}/resolution`, { method: "POST", body: { decision, resolution } });
      reload();
      return `Report ${decision}.`;
    });
  }

  return (
    <Card title="Open reports">
      {action.error ? <Notice tone="danger">{action.error}</Notice> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {!data.reports.length ? <EmptyState title="No open reports" description="Public reports about listings appear here." /> : (
        <Table head={["Listing", "Issue", "Detail", "Reported", "Decision"]}>
          {data.reports.map((report) => (
            <tr key={report.id}>
              <td><strong>{report.name}</strong><div className="mv-small mv-muted">{report.publicId}</div></td>
              <td><Badge tone="warning">{report.reportType}</Badge></td>
              <td className="mv-small">{report.detail}<div className="mv-muted">{report.reporterContact ?? "no contact"}</div></td>
              <td className="mv-small">{formatDate(report.createdAt)}</td>
              <td><div className="mv-row mv-wrap"><Button size="sm" onClick={() => void resolve(report.id, "resolved")} disabled={Boolean(action.busy)}>Resolve</Button><Button size="sm" variant="secondary" onClick={() => void resolve(report.id, "dismissed")} disabled={Boolean(action.busy)}>Dismiss</Button></div></td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

function Sponsorship({ campaigns, loading, error, reload }: { campaigns: Campaign[]; loading: boolean; error: string | null; reload: () => void }) {
  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  return (
    <Card title="Campaigns" description="Confirm settlement only when the payment reference is verified. Then record an independent editorial decision.">
      {!campaigns.length ? <EmptyState title="No campaigns" description="Provider campaign requests appear here." /> : (
        <Table head={["Campaign", "Dates", "Payment", "Editorial", "Decision"]}>
          {campaigns.map((campaign) => <CampaignRow key={campaign.id} campaign={campaign} reload={reload} />)}
        </Table>
      )}
    </Card>
  );
}

function CampaignRow({ campaign, reload }: { campaign: Campaign; reload: () => void }) {
  const action = useAction();
  const payments = useQuery<{ payments: Payment[] }>(`/promotions/campaigns/${campaign.id}/payments`);

  async function confirm(payment: Payment) {
    const providerReference = window.prompt("Verified provider reference:", payment.providerReference ?? "");
    if (!providerReference || providerReference.trim().length < 2) return;
    await action.run(`confirm-${payment.id}`, async () => {
      await api(`/promotions/payments/${payment.id}/confirm`, { method: "POST", body: { providerReference, notes: "Confirmed by platform billing operator" } });
      payments.reload();
      reload();
      return "Payment confirmed. Editorial approval is still required.";
    });
  }

  async function decide(decision: "approve" | "reject") {
    const note = window.prompt("Editorial decision note (minimum 5 characters):", decision === "approve" ? "Placement, labelling and eligibility reviewed" : "Placement does not meet editorial policy");
    if (!note || note.trim().length < 5) return;
    await action.run(`decision-${campaign.id}`, async () => {
      await api(`/promotions/campaigns/${campaign.id}/decision`, { method: "POST", body: { decision, note } });
      reload();
      return `Campaign ${decision === "approve" ? "approved" : "rejected"}.`;
    });
  }

  return (
    <tr>
      <td><strong>{campaign.packageNameSnapshot}</strong><div className="mv-small mv-muted">{campaign.facilityName} · {campaign.publicId} · {campaign.placementSurface.replaceAll("-", " ")}</div></td>
      <td className="mv-small">{formatDate(campaign.startsOn)} — {formatDate(campaign.endsOn)}</td>
      <td>
        <Badge tone={campaign.paymentStatus === "paid" ? "success" : campaign.paymentStatus === "pending" ? "warning" : "neutral"}>{campaign.paymentStatus}</Badge>
        <div className="mv-small">{formatMoney(campaign.amountSnapshot, campaign.currencySnapshot)}</div>
        {payments.loading ? <span className="mv-small mv-muted">Loading payments…</span> : payments.data?.payments.map((payment) => (
          <div key={payment.id} className="mv-small">
            {payment.provider} · {payment.status}
            {payment.status === "pending" ? <> <Button size="sm" variant="secondary" onClick={() => void confirm(payment)} disabled={Boolean(action.busy)}>Confirm</Button></> : null}
          </div>
        ))}
      </td>
      <td><Badge tone={campaign.editorialStatus === "approved" ? "success" : campaign.editorialStatus === "rejected" ? "danger" : "warning"}>{campaign.editorialStatus}</Badge><div className="mv-small">{campaign.status}</div></td>
      <td>
        <div className="mv-row mv-wrap">
          {campaign.paymentStatus === "paid" && campaign.status === "pending-review" ? <Button size="sm" onClick={() => void decide("approve")} disabled={Boolean(action.busy)}>Approve placement</Button> : null}
          {["pending-review", "scheduled", "active"].includes(campaign.status) ? <Button size="sm" variant="danger" onClick={() => void decide("reject")} disabled={Boolean(action.busy)}>Reject</Button> : null}
        </div>
        {action.error ? <span className="mv-small" role="alert">{action.error}</span> : null}
        {action.message ? <span className="mv-small">{action.message}</span> : null}
      </td>
    </tr>
  );
}
