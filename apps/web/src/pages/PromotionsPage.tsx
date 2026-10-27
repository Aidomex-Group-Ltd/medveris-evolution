import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDate, formatMoney, todayInput } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

interface ProviderFacility { id: string; publicId: string; name: string; publicationStatus: string }

interface Package {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price: string | number;
  currency: string;
  durationDays: number;
  eligibleCountries: string[];
  eligibleFacilityTypes: string[];
  eligibleServiceCategories: string[];
  placementSurface: string;
  sponsoredSlots: number;
  maxActivePerFacility: number;
  requirements: string | null;
}

interface Campaign {
  id: string;
  packageNameSnapshot: string;
  facilityName: string;
  publicId: string;
  placementSurface: string;
  amountSnapshot: string | number;
  currencySnapshot: string;
  status: string;
  paymentStatus: string;
  editorialStatus: string;
  startsOn: string;
  endsOn: string;
  createdAt: string;
  decisionReason: string | null;
}

interface Metric { id: string; metricDate: string; surface: string; impressions: number; detailOpens: number; pinInteractions: number; contactClicks: number; directionsClicks: number; bookingInitiations: number }

const STATUS_TONE: Record<string, "neutral" | "warning" | "success" | "danger" | "info"> = {
  "pending-review": "warning", scheduled: "info", active: "success", paused: "warning", rejected: "danger", expired: "neutral", cancelled: "neutral",
};

export function PromotionsPage() {
  const facilities = useQuery<{ facilities: ProviderFacility[] }>("/directory/facilities");
  const packages = useQuery<{ packages: Package[] }>("/promotions/packages");
  const campaigns = useQuery<{ campaigns: Campaign[] }>("/promotions/campaigns");

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Paid placement"
        title="Sponsorship campaigns"
        description="Buy labelled visibility only. Payment never changes organic ranking, credential verification, capability evidence, emergency criteria or access to patient records."
        actions={<Link className="mv-button mv-button--secondary mv-button--md" to="/provider-directory">Back to listings</Link>}
      />
      <Notice tone="warning" title="Separation rules">
        Campaigns require a paid, confirmed package and separate editorial approval. Sponsored placements are labelled, rotate, and are capped per facility. Clinical emergency guidance is never sponsored.
      </Notice>
      <CampaignForm facilities={facilities.data?.facilities ?? []} packages={packages.data?.packages ?? []} onCreated={() => campaigns.reload()} loadingPackages={packages.loading} />
      <Card title="My campaigns">
        {campaigns.loading ? <LoadingState /> : campaigns.error ? <ErrorState message={campaigns.error} onRetry={campaigns.reload} /> : !campaigns.data?.campaigns.length ? <EmptyState title="No campaigns" description="Create a campaign above to request a labelled placement." /> : (
          <Table head={["Campaign", "Dates", "Payment", "Editorial", "Status", "Actions"]}>
            {campaigns.data.campaigns.map((campaign) => <CampaignRow key={campaign.id} campaign={campaign} reload={campaigns.reload} />)}
          </Table>
        )}
      </Card>
    </div>
  );
}

function CampaignForm({ facilities, packages, loadingPackages, onCreated }: { facilities: ProviderFacility[]; packages: Package[]; loadingPackages: boolean; onCreated: () => void }) {
  const action = useAction();
  const inThirty = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const [form, setForm] = useState({
    packageId: "", facilityId: "", startsOn: todayInput(), endsOn: inThirty,
    scopeCountry: "Uganda", scopeRegion: "", scopeDistrict: "", scopeLocality: "", serviceCategories: "",
  });
  const selected = useMemo(() => packages.find((pkg) => pkg.id === form.packageId) ?? null, [packages, form.packageId]);
  const claimed = facilities.filter((facility) => facility.publicationStatus === "published" || facility.publicationStatus === "pending-review");

  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run("create", async () => {
      await api("/promotions/campaigns", {
        method: "POST",
        body: {
          ...form,
          serviceCategories: form.serviceCategories.split(",").map((value) => value.trim()).filter(Boolean),
        },
      });
      onCreated();
      return "Campaign submitted. Payment confirmation and editorial approval are both required before it can appear.";
    });
  }

  return (
    <Card title="Request a placement" description="Packages show the exact surface, duration and eligibility. Eligibility is enforced by the server.">
      {action.error ? <Notice tone="danger">{action.error}</Notice> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {loadingPackages ? <LoadingState label="Loading packages" /> : (
        <form className="mv-form-grid" onSubmit={submit}>
          <Field label="Package">
            <Select required value={form.packageId} onChange={(event) => setForm({ ...form, packageId: event.target.value })}>
              <option value="">Select a package</option>
              {packages.map((pkg) => <option key={pkg.id} value={pkg.id}>{pkg.name} · {formatMoney(pkg.price, pkg.currency)} · {pkg.durationDays} days</option>)}
            </Select>
          </Field>
          <Field label="Facility listing">
            <Select required value={form.facilityId} onChange={(event) => setForm({ ...form, facilityId: event.target.value })}>
              <option value="">Select a claimed listing</option>
              {claimed.map((facility) => <option key={facility.id} value={facility.id}>{facility.name} ({facility.publicId})</option>)}
            </Select>
          </Field>
          <Field label="Starts on"><Input required type="date" value={form.startsOn} onChange={(event) => setForm({ ...form, startsOn: event.target.value })} /></Field>
          <Field label="Ends on"><Input required type="date" value={form.endsOn} onChange={(event) => setForm({ ...form, endsOn: event.target.value })} /></Field>
          <Field label="Scope country"><Input value={form.scopeCountry} onChange={(event) => setForm({ ...form, scopeCountry: event.target.value })} /></Field>
          <Field label="Scope region"><Input value={form.scopeRegion} onChange={(event) => setForm({ ...form, scopeRegion: event.target.value })} /></Field>
          <Field label="Scope district"><Input value={form.scopeDistrict} onChange={(event) => setForm({ ...form, scopeDistrict: event.target.value })} /></Field>
          <Field label="Service categories" hint="Comma-separated. Leave blank to target all eligible services."><Input value={form.serviceCategories} onChange={(event) => setForm({ ...form, serviceCategories: event.target.value })} placeholder="outpatient, diagnostics" /></Field>
          {selected ? <Notice tone="neutral" title="Package terms">{selected.placementSurface.replaceAll("-", " ")} · {selected.sponsoredSlots} slot(s) · max {selected.maxActivePerFacility} active per facility{selected.requirements ? ` · ${selected.requirements}` : ""}{selected.eligibleServiceCategories.length ? ` · categories: ${selected.eligibleServiceCategories.join(", ")}` : ""}</Notice> : null}
          <div className="mv-form-actions"><Button type="submit" disabled={Boolean(action.busy) || !claimed.length}>{action.busy ? "Submitting…" : "Submit campaign"}</Button></div>
        </form>
      )}
    </Card>
  );
}

function CampaignRow({ campaign, reload }: { campaign: Campaign; reload: () => void }) {
  const action = useAction();
  const [metrics, setMetrics] = useState<Metric[] | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);

  async function initiatePayment() {
    await action.run("pay", async () => {
      const result = await api<{ payment: { id: string } }>(`/promotions/campaigns/${campaign.id}/payments`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: { method: "manual", notes: "Payment initiated from provider workspace" },
      });
      setPaymentId(result.payment.id);
      reload();
      return "Payment recorded as pending. A Medveris billing operator must confirm settlement; no card data is collected.";
    });
  }

  async function loadMetrics() {
    await action.run("metrics", async () => {
      const result = await api<{ metrics: Metric[] }>(`/promotions/campaigns/${campaign.id}/metrics`);
      setMetrics(result.metrics);
    });
  }

  async function pause() {
    await action.run("pause", async () => { await api(`/promotions/campaigns/${campaign.id}/pause`, { method: "POST" }); reload(); return "Campaign paused."; });
  }

  async function cancel() {
    if (!window.confirm("Cancel this campaign? This cannot be undone.")) return;
    await action.run("cancel", async () => { await api(`/promotions/campaigns/${campaign.id}/cancel`, { method: "POST" }); reload(); return "Campaign cancelled."; });
  }

  return (
    <tr>
      <td><strong>{campaign.packageNameSnapshot}</strong><div className="mv-small mv-muted">{campaign.facilityName} · {campaign.publicId} · {campaign.placementSurface.replaceAll("-", " ")}</div></td>
      <td className="mv-small">{formatDate(campaign.startsOn)} — {formatDate(campaign.endsOn)}</td>
      <td><Badge tone={campaign.paymentStatus === "paid" ? "success" : campaign.paymentStatus === "pending" ? "warning" : "neutral"}>{campaign.paymentStatus}</Badge><div className="mv-small">{formatMoney(campaign.amountSnapshot, campaign.currencySnapshot)}</div></td>
      <td><Badge tone={campaign.editorialStatus === "approved" ? "success" : campaign.editorialStatus === "rejected" ? "danger" : "warning"}>{campaign.editorialStatus}</Badge></td>
      <td><Badge tone={STATUS_TONE[campaign.status] ?? "neutral"}>{campaign.status}</Badge>{campaign.decisionReason ? <div className="mv-small mv-muted">{campaign.decisionReason}</div> : null}</td>
      <td>
        <div className="mv-stack">
          {campaign.status === "pending-review" && (campaign.paymentStatus === "unpaid" || campaign.paymentStatus === "pending") ? <Button size="sm" onClick={() => void initiatePayment()} disabled={Boolean(action.busy)}>Record payment</Button> : null}
          {paymentId ? <span className="mv-small mv-muted">Payment {paymentId.slice(0, 8)} pending confirmation</span> : null}
          <div className="mv-row mv-wrap">
            <Button size="sm" variant="ghost" onClick={() => void loadMetrics()} disabled={Boolean(action.busy)}>Metrics</Button>
            {["active", "scheduled"].includes(campaign.status) ? <Button size="sm" variant="secondary" onClick={() => void pause()} disabled={Boolean(action.busy)}>Pause</Button> : null}
            {!["expired", "cancelled", "rejected"].includes(campaign.status) ? <Button size="sm" variant="danger" onClick={() => void cancel()} disabled={Boolean(action.busy)}>Cancel</Button> : null}
          </div>
          {action.error ? <span className="mv-small" role="alert">{action.error}</span> : null}
          {action.message ? <span className="mv-small">{action.message}</span> : null}
          {metrics ? metrics.length ? (
            <div className="mv-small">
              <Textarea readOnly rows={Math.min(6, metrics.length + 1)} value={["date · surface · impressions · detail · pins · contacts · directions · bookings", ...metrics.map((metric) => `${metric.metricDate} · ${metric.surface} · ${metric.impressions} · ${metric.detailOpens} · ${metric.pinInteractions} · ${metric.contactClicks} · ${metric.directionsClicks} · ${metric.bookingInitiations}`)].join("\n")} />
            </div>
          ) : <span className="mv-small mv-muted">No events recorded yet.</span> : null}
        </div>
      </td>
    </tr>
  );
}
