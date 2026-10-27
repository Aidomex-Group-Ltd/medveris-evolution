import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

interface ProviderFacility {
  id: string;
  publicId: string;
  name: string;
  facilityType: string;
  publicationStatus: string;
  status: string;
  credentialStatus: string;
  capabilityStatus: string;
  lastConfirmedOn: string | null;
  nextConfirmationOn: string | null;
  claimedTenantId: string | null;
  version: number;
  updatedAt: string;
}

interface Claim {
  id: string;
  facilityId: string;
  representativeName: string;
  roleTitle: string;
  status: string;
  createdAt: string;
  decisionReason: string | null;
}

const TYPES = ["hospital", "clinic", "health-centre", "diagnostic-centre", "pharmacy", "dental", "eye", "mental-health", "rehabilitation", "maternity", "other"];
const SERVICE_CATEGORIES = ["outpatient", "inpatient", "emergency", "maternal", "child-health", "diagnostics", "pharmacy", "dental", "eye", "mental-health", "rehabilitation", "surgery", "other"];

export function ProviderDirectoryPage() {
  const [tab, setTab] = useState<"listings" | "create" | "claim">("listings");
  const facilities = useQuery<{ facilities: ProviderFacility[] }>("/directory/facilities");
  const claims = useQuery<{ claims: Claim[] }>("/directory/claims");

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Provider directory workspace"
        title="Facility listings"
        description="Maintain claimed public listings. Payment, credential verification and documented capabilities remain separate states."
        actions={<Link className="mv-button mv-button--secondary mv-button--md" to="/promotions">Sponsorship campaigns</Link>}
      />
      <Notice tone="info" title="Editorial separation">
        Updating a listing after publication returns it to editorial review. Capability evidence can only be marked verified by a Medveris operator. Sponsored placement never changes verification.
      </Notice>
      <Tabs label="Provider directory sections" value={tab} onChange={setTab} options={[
        { value: "listings", label: "My listings" },
        { value: "create", label: "Register a facility" },
        { value: "claim", label: "Claim a listing" },
      ]} />
      {tab === "listings" ? <Listings facilities={facilities} /> : null}
      {tab === "create" ? <CreateListing onCreated={() => { facilities.reload(); setTab("listings"); }} /> : null}
      {tab === "claim" ? <ClaimListing claims={claims} onClaimed={() => { claims.reload(); facilities.reload(); }} /> : null}
    </div>
  );
}

function Listings({ facilities }: { facilities: ReturnType<typeof useQuery<{ facilities: ProviderFacility[] }>> }) {
  const action = useAction();
  const [managing, setManaging] = useState<ProviderFacility | null>(null);
  const [serviceCode, setServiceCode] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [serviceCategory, setServiceCategory] = useState("outpatient");
  const [branchName, setBranchName] = useState("");
  const [branchCity, setBranchCity] = useState("");
  const [branchLat, setBranchLat] = useState("");
  const [branchLng, setBranchLng] = useState("");

  async function edit(facility: ProviderFacility) {
    const description = window.prompt(`Public description for ${facility.name}`, "");
    if (description == null) return;
    const phone = window.prompt("Public phone", "") ?? "";
    const email = window.prompt("Public email", "") ?? "";
    await action.run("edit", async () => {
      await api(`/directory/facilities/${facility.id}`, { method: "PATCH", body: { description, publicPhone: phone, publicEmail: email, version: facility.version } });
      facilities.reload();
      return "Listing updated and returned to editorial review.";
    });
  }

  async function confirm(facility: ProviderFacility) {
    await action.run(`confirm-${facility.id}`, async () => {
      await api(`/directory/facilities/${facility.id}/confirm`, { method: "POST", body: { note: "Confirmed from provider workspace" } });
      facilities.reload();
      return "Listing confirmed as current.";
    });
  }

  async function addService(facility: ProviderFacility) {
    await action.run(`service-${facility.id}`, async () => {
      await api(`/directory/facilities/${facility.id}/services`, { method: "POST", body: { code: serviceCode, name: serviceName, category: serviceCategory } });
      setServiceCode("");
      setServiceName("");
      facilities.reload();
      return "Service added.";
    });
  }

  async function addBranch(facility: ProviderFacility) {
    await action.run(`branch-${facility.id}`, async () => {
      await api(`/directory/facilities/${facility.id}/branches`, {
        method: "POST",
        body: {
          name: branchName, isPrimary: false, country: "Uganda", city: branchCity,
          latitude: branchLat ? Number(branchLat) : null, longitude: branchLng ? Number(branchLng) : null,
          coordinateSource: branchLat ? "map-pin" : "unknown", locationStatus: branchLat ? "confirmed" : "unconfirmed",
        },
      });
      setBranchName("");
      setBranchCity("");
      setBranchLat("");
      setBranchLng("");
      facilities.reload();
      return "Branch added.";
    });
  }

  return (
    <Card title="Claimed and submitted listings">
      {action.error ? <Notice tone="danger">{action.error}</Notice> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {facilities.loading ? <LoadingState /> : facilities.error ? <ErrorState message={facilities.error} onRetry={facilities.reload} /> : !facilities.data?.facilities.length ? (
        <EmptyState title="No listings yet" description="Register a facility or claim an existing public listing to begin." />
      ) : (
        <Table head={["Facility", "Publication", "Verification", "Confirmed", "Actions"]}>
          {facilities.data.facilities.map((facility) => (
            <tr key={facility.id}>
              <td><strong>{facility.name}</strong><div className="mv-small mv-muted">{facility.publicId} · {facility.facilityType.replaceAll("-", " ")}</div></td>
              <td><Badge tone={facility.publicationStatus === "published" ? "success" : "warning"}>{facility.publicationStatus}</Badge></td>
              <td><div className="mv-small">Credentials: {facility.credentialStatus}</div><div className="mv-small">Capabilities: {facility.capabilityStatus}</div></td>
              <td className="mv-small">{formatDate(facility.lastConfirmedOn)}<div className="mv-muted">next {formatDate(facility.nextConfirmationOn)}</div></td>
              <td><div className="mv-row mv-wrap"><Button size="sm" variant="secondary" onClick={() => void edit(facility)}>Edit</Button><Button size="sm" variant="secondary" onClick={() => void confirm(facility)}>Confirm current</Button><Button size="sm" variant="ghost" onClick={() => setManaging(managing?.id === facility.id ? null : facility)}>Services and branches</Button></div></td>
            </tr>
          ))}
        </Table>
      )}
      {managing ? (
        <div className="mv-stack">
          <Notice tone="neutral" title={`Extend ${managing.name}`}>New services are published as declared services. Capability verification requires operator review.</Notice>
          <div className="mv-grid-2">
            <form className="mv-stack" onSubmit={(event: FormEvent) => { event.preventDefault(); void addService(managing); }}>
              <Field label="Service code"><Input required value={serviceCode} onChange={(event) => setServiceCode(event.target.value)} placeholder="OUTPATIENT-GENERAL" /></Field>
              <Field label="Service name"><Input required value={serviceName} onChange={(event) => setServiceName(event.target.value)} /></Field>
              <Field label="Category"><Select value={serviceCategory} onChange={(event) => setServiceCategory(event.target.value)}>{SERVICE_CATEGORIES.map((category) => <option key={category} value={category}>{category.replaceAll("-", " ")}</option>)}</Select></Field>
              <Button type="submit" disabled={Boolean(action.busy)}>Add service</Button>
            </form>
            <form className="mv-stack" onSubmit={(event: FormEvent) => { event.preventDefault(); void addBranch(managing); }}>
              <Field label="Branch name"><Input required value={branchName} onChange={(event) => setBranchName(event.target.value)} /></Field>
              <Field label="City"><Input value={branchCity} onChange={(event) => setBranchCity(event.target.value)} /></Field>
              <Field label="Latitude" hint="Coordinates are published publicly. Confirm accuracy before saving."><Input type="number" step="0.000001" value={branchLat} onChange={(event) => setBranchLat(event.target.value)} /></Field>
              <Field label="Longitude"><Input type="number" step="0.000001" value={branchLng} onChange={(event) => setBranchLng(event.target.value)} /></Field>
              <Button type="submit" variant="secondary" disabled={Boolean(action.busy)}>Add branch</Button>
            </form>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function CreateListing({ onCreated }: { onCreated: () => void }) {
  const action = useAction();
  const [form, setForm] = useState({
    name: "", facilityType: "clinic", description: "", country: "Uganda", region: "", district: "", locality: "",
    publicPhone: "", publicEmail: "", website: "",
  });
  const [branch, setBranch] = useState({ name: "Main branch", city: "", latitude: "", longitude: "" });
  const [serviceName, setServiceName] = useState("Outpatient consultation");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const ok = await action.run("create", async () => {
      await api("/directory/facilities", {
        method: "POST",
        body: {
          ...form,
          sourceKind: "facility-submitted",
          branches: [{
            name: branch.name, isPrimary: true, country: form.country, city: branch.city || form.locality,
            district: form.district, region: form.region, locality: form.locality,
            latitude: branch.latitude ? Number(branch.latitude) : null,
            longitude: branch.longitude ? Number(branch.longitude) : null,
            coordinateSource: branch.latitude ? "facility-supplied" : "unknown",
            locationStatus: branch.latitude ? "confirmed" : "unconfirmed",
          }],
          services: [{ code: serviceName.toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 60), name: serviceName, category: "outpatient" }],
          capabilities: [],
        },
      });
      onCreated();
      return "Facility registered. It is pending editorial review before publication.";
    });
    void ok;
  }

  return (
    <Card title="Register a facility" description="Registration is free. New listings are reviewed before publication. Verification and sponsorship are separate and never bundled.">
      {action.error ? <Notice tone="danger">{action.error}</Notice> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <form className="mv-form-grid" onSubmit={submit}>
        <Field label="Facility name"><Input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
        <Field label="Facility type"><Select value={form.facilityType} onChange={(event) => setForm({ ...form, facilityType: event.target.value })}>{TYPES.map((type) => <option key={type} value={type}>{type.replaceAll("-", " ")}</option>)}</Select></Field>
        <Field label="Country"><Input required value={form.country} onChange={(event) => setForm({ ...form, country: event.target.value })} /></Field>
        <Field label="Region"><Input value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value })} /></Field>
        <Field label="District"><Input value={form.district} onChange={(event) => setForm({ ...form, district: event.target.value })} /></Field>
        <Field label="Locality"><Input value={form.locality} onChange={(event) => setForm({ ...form, locality: event.target.value })} /></Field>
        <Field label="Public phone"><Input value={form.publicPhone} onChange={(event) => setForm({ ...form, publicPhone: event.target.value })} /></Field>
        <Field label="Public email"><Input type="email" value={form.publicEmail} onChange={(event) => setForm({ ...form, publicEmail: event.target.value })} /></Field>
        <Field label="Website"><Input type="url" value={form.website} onChange={(event) => setForm({ ...form, website: event.target.value })} /></Field>
        <Field label="Description"><Textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
        <Field label="Branch name"><Input required value={branch.name} onChange={(event) => setBranch({ ...branch, name: event.target.value })} /></Field>
        <Field label="City"><Input value={branch.city} onChange={(event) => setBranch({ ...branch, city: event.target.value })} /></Field>
        <Field label="Latitude" hint="Optional; publish only verified public coordinates."><Input type="number" step="0.000001" value={branch.latitude} onChange={(event) => setBranch({ ...branch, latitude: event.target.value })} /></Field>
        <Field label="Longitude"><Input type="number" step="0.000001" value={branch.longitude} onChange={(event) => setBranch({ ...branch, longitude: event.target.value })} /></Field>
        <Field label="Primary service"><Input required value={serviceName} onChange={(event) => setServiceName(event.target.value)} /></Field>
        <div className="mv-form-actions"><Button type="submit" disabled={Boolean(action.busy)}>{action.busy ? "Submitting…" : "Submit for review"}</Button></div>
      </form>
    </Card>
  );
}

function ClaimListing({ claims, onClaimed }: { claims: ReturnType<typeof useQuery<{ claims: Claim[] }>>; onClaimed: () => void }) {
  const action = useAction();
  const [publicId, setPublicId] = useState("");
  const [form, setForm] = useState({ representativeName: "", roleTitle: "", email: "", phone: "", authorityBasis: "", evidence: "" });
  const rows = useMemo(() => claims.data?.claims ?? [], [claims.data]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run("claim", async () => {
      await api(`/directory/claims?facility=${encodeURIComponent(publicId)}`, { method: "POST", body: form });
      onClaimed();
      return "Claim submitted for operator review. The listing is not changed until the claim is verified.";
    });
  }

  return (
    <div className="mv-stack">
      <Card title="Claim an existing public listing" description="Claims require evidence of authority. A verified claim links the listing to your organization and returns it to editorial review.">
        {action.error ? <Notice tone="danger">{action.error}</Notice> : null}
        {action.message ? <Notice tone="success">{action.message}</Notice> : null}
        <form className="mv-form-grid" onSubmit={submit}>
          <Field label="Listing public ID" hint="For example MV-DIR-NAG-01"><Input required value={publicId} onChange={(event) => setPublicId(event.target.value)} /></Field>
          <Field label="Representative name"><Input required value={form.representativeName} onChange={(event) => setForm({ ...form, representativeName: event.target.value })} /></Field>
          <Field label="Role title"><Input required value={form.roleTitle} onChange={(event) => setForm({ ...form, roleTitle: event.target.value })} /></Field>
          <Field label="Email"><Input required type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
          <Field label="Phone"><Input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></Field>
          <Field label="Authority basis" hint="Describe your authority to act for the facility. Do not include patient information."><Textarea required minLength={10} value={form.authorityBasis} onChange={(event) => setForm({ ...form, authorityBasis: event.target.value })} /></Field>
          <Field label="Evidence reference (optional)"><Input value={form.evidence} onChange={(event) => setForm({ ...form, evidence: event.target.value })} /></Field>
          <div className="mv-form-actions"><Button type="submit" disabled={Boolean(action.busy)}>Submit claim</Button></div>
        </form>
      </Card>
      <Card title="My claims">
        {claims.loading ? <LoadingState /> : claims.error ? <ErrorState message={claims.error} onRetry={claims.reload} /> : !rows.length ? <EmptyState title="No claims" description="Submitted claims appear here with their review status." /> : (
          <Table head={["Representative", "Status", "Submitted", "Reason"]}>
            {rows.map((claim) => <tr key={claim.id}><td>{claim.representativeName}<div className="mv-small mv-muted">{claim.roleTitle}</div></td><td><Badge tone={claim.status === "verified" ? "success" : claim.status === "rejected" ? "danger" : "warning"}>{claim.status}</Badge></td><td className="mv-small">{formatDate(claim.createdAt)}</td><td className="mv-small">{claim.decisionReason ?? "—"}</td></tr>)}
          </Table>
        )}
      </Card>
    </div>
  );
}
