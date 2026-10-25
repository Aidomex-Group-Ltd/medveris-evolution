import { useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { PatientPicker } from "../components/Pickers";

interface Bed { id: string; label: string; status: string; statusReason: string | null; version: number; wardName: string; wardType: string; lastChangeTo: string | null; lastChangeAt: string | null }
interface CleaningTask { id: string; bedId: string | null; zone: string; taskType: string; riskLevel: string; status: string; instructions: string | null; bedLabel: string | null; wardName: string | null; assignedToName: string | null; createdAt: string }
interface PorterTask { id: string; requestType: string; patientId: string | null; fromLocation: string; toLocation: string; status: string; identityChecked: boolean; specimenCustody: boolean; givenName: string | null; familyName: string | null; publicId: string | null; assignedToName: string | null; createdAt: string }
interface MortuaryCase { id: string; caseRef: string; patientId: string | null; deceasedName: string; identityStatus: string; status: string; storageLocation: string; receivedAt: string; released: boolean }
interface Asset { id: string; assetRef: string; name: string; category: string; status: string; nextMaintenanceOn: string | null; openWorkOrders: number }
interface WorkOrder { id: string; assetId: string; fault: string; priority: string; status: string; assetName: string; assetRef: string; createdAt: string }
interface CssdCycle { id: string; sterilizer: string; cycleRef: string; loadCount: number; indicatorResult: string; status: string; createdAt: string }

const BED_ACTIONS = ["awaiting-cleaning", "cleaning-in-progress", "ready", "available", "out-of-service"];

export function OperationsPage() {
  const [tab, setTab] = useState<"beds" | "cleaning" | "portering" | "mortuary" | "technical">("beds");
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Hospital operations" title="Ward readiness and support services" description="Bed turnaround, cleaning, portering, mortuary custody and technical services are separate operational records. Clinical discharge never marks a bed clean by itself." />
      <Tabs label="Operations sections" value={tab} onChange={setTab} options={[
        { value: "beds", label: "Bed readiness" },
        { value: "cleaning", label: "Housekeeping" },
        { value: "portering", label: "Portering" },
        { value: "mortuary", label: "Mortuary" },
        { value: "technical", label: "Technical services" },
      ]} />
      {tab === "beds" ? <Beds /> : null}
      {tab === "cleaning" ? <Cleaning /> : null}
      {tab === "portering" ? <Portering /> : null}
      {tab === "mortuary" ? <Mortuary /> : null}
      {tab === "technical" ? <Technical /> : null}
    </div>
  );
}

function Beds() {
  const beds = useQuery<{ beds: Bed[] }>("/operations/beds");
  const action = useAction();

  async function move(bed: Bed, status: string) {
    await action.run(bed.id, async () => {
      await api(`/operations/beds/${bed.id}/readiness`, { method: "POST", body: { status, expectedVersion: bed.version } });
      beds.reload();
      return `Bed ${bed.label} marked ${status}.`;
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Bed readiness" description="Vacated beds progress through cleaning before becoming available again.">
        {beds.loading ? <LoadingState /> : beds.error ? <ErrorState message={beds.error} onRetry={beds.reload} /> : !beds.data?.beds.length ? <EmptyState title="No beds" description="Configure wards and beds first." /> : (
          <Table head={["Ward / bed", "Status", "Last change", "Actions"]} caption="Bed readiness">
            {beds.data.beds.map((bed) => (
              <tr key={bed.id}>
                <td><strong>{bed.wardName}</strong><div className="mv-small mv-muted">{bed.label}</div></td>
                <td><Badge tone={bed.status === "available" ? "success" : bed.status === "occupied" ? "info" : bed.status === "out-of-service" ? "danger" : "warning"}>{bed.status}</Badge>{bed.statusReason ? <div className="mv-small mv-muted">{bed.statusReason}</div> : null}</td>
                <td className="mv-small">{bed.lastChangeAt ? `${formatDateTime(bed.lastChangeAt)} → ${bed.lastChangeTo}` : "—"}</td>
                <td><div className="mv-row">{BED_ACTIONS.filter((status) => status !== bed.status).map((status) => <Button key={status} size="sm" variant="ghost" onClick={() => void move(bed, status)} disabled={action.busy !== null}>{status}</Button>)}</div></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function Cleaning() {
  const tasks = useQuery<{ tasks: CleaningTask[] }>("/housekeeping/tasks");
  const beds = useQuery<{ beds: Bed[] }>("/operations/beds");
  const action = useAction();
  const [bedId, setBedId] = useState("");
  const [zone, setZone] = useState("Ward A");
  const [taskType, setTaskType] = useState("routine");
  const [riskLevel, setRiskLevel] = useState("low");

  async function create(event: FormEvent) {
    event.preventDefault();
    await action.run("create", async () => {
      await api("/housekeeping/tasks", { method: "POST", body: { bedId: bedId || null, zone, taskType, riskLevel } });
      tasks.reload();
      return "Cleaning task created.";
    });
  }

  async function transition(task: CleaningTask, status: string) {
    await action.run(task.id, async () => {
      await api(`/housekeeping/tasks/${task.id}/transition`, { method: "POST", body: { status } });
      tasks.reload();
      beds.reload();
      return `Task moved to ${status}.`;
    });
  }

  const nextStatus = (status: string): string | null => status === "assigned" ? "in-progress" : status === "in-progress" ? "completed" : status === "completed" ? "verified" : null;

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Create a cleaning task" description="Completing a bed-linked task marks the bed ready; verification makes it available.">
        <form className="mv-stack" onSubmit={create}>
          <div className="mv-form-grid">
            <Field label="Bed"><Select value={bedId} onChange={(event) => setBedId(event.target.value)}><option value="">No specific bed</option>{beds.data?.beds.map((bed) => <option key={bed.id} value={bed.id}>{bed.wardName} — {bed.label}</option>)}</Select></Field>
            <Field label="Zone" htmlFor="clean-zone"><Input id="clean-zone" value={zone} onChange={(event) => setZone(event.target.value)} required /></Field>
            <Field label="Task type"><Select value={taskType} onChange={(event) => setTaskType(event.target.value)}>{["routine", "terminal", "discharge", "isolation", "spill", "inspection", "other"].map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
            <Field label="Risk level"><Select value={riskLevel} onChange={(event) => setRiskLevel(event.target.value)}>{["low", "medium", "high"].map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
          </div>
          <Button type="submit" disabled={action.busy !== null || !zone.trim()}>{action.busy === "create" ? "Creating…" : "Create cleaning task"}</Button>
        </form>
      </Card>
      <Card title="Cleaning tasks">
        {tasks.loading ? <LoadingState /> : tasks.error ? <ErrorState message={tasks.error} onRetry={tasks.reload} /> : !tasks.data?.tasks.length ? <EmptyState title="No cleaning tasks" description="Create a task above." /> : (
          <Table head={["Zone", "Bed", "Type", "Status", ""]} caption="Cleaning tasks">
            {tasks.data.tasks.map((task) => (
              <tr key={task.id}>
                <td><strong>{task.zone}</strong><div className="mv-small mv-muted">{task.instructions}</div></td>
                <td>{task.bedLabel ? `${task.wardName} — ${task.bedLabel}` : "—"}</td>
                <td>{task.taskType}<div className="mv-small mv-muted">{task.riskLevel} risk</div></td>
                <td><Badge tone={task.status === "verified" || task.status === "completed" ? "success" : task.status === "cancelled" ? "danger" : "warning"}>{task.status}</Badge></td>
                <td>{nextStatus(task.status) ? <Button size="sm" variant="secondary" onClick={() => void transition(task, nextStatus(task.status)!)} disabled={action.busy !== null}>{nextStatus(task.status)}</Button> : null}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function Portering() {
  const tasks = useQuery<{ tasks: PorterTask[] }>("/porter/tasks");
  const action = useAction();
  const [patientId, setPatientId] = useState("");
  const [requestType, setRequestType] = useState("patient-transfer");
  const [fromLocation, setFromLocation] = useState("");
  const [toLocation, setToLocation] = useState("");
  const [specimenCustody, setSpecimenCustody] = useState(false);

  async function create(event: FormEvent) {
    event.preventDefault();
    await action.run("create", async () => {
      await api("/porter/tasks", { method: "POST", body: { requestType, patientId: patientId || null, fromLocation, toLocation, specimenCustody } });
      setFromLocation("");
      setToLocation("");
      tasks.reload();
      return "Porter task requested.";
    });
  }

  async function transition(task: PorterTask, status: string) {
    await action.run(task.id, async () => {
      await api(`/porter/tasks/${task.id}/transition`, { method: "POST", body: { status, identityChecked: status === "completed" ? true : undefined } });
      tasks.reload();
      return `Porter task moved to ${status}.`;
    });
  }

  const nextStatus = (status: string): string | null => status === "requested" ? "accepted" : status === "accepted" ? "in-progress" : status === "in-progress" ? "completed" : null;

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Request a porter task" description="Specimen tasks always require custody tracking. Patient transfers require identity verification at completion.">
        <form className="mv-stack" onSubmit={create}>
          <div className="mv-form-grid">
            <Field label="Request type"><Select value={requestType} onChange={(event) => setRequestType(event.target.value)}>{["patient-transfer", "specimen", "equipment", "document", "other"].map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
            <PatientPicker value={patientId} onChange={setPatientId} required={false} />
            <Field label="From" htmlFor="porter-from"><Input id="porter-from" value={fromLocation} onChange={(event) => setFromLocation(event.target.value)} required /></Field>
            <Field label="To" htmlFor="porter-to"><Input id="porter-to" value={toLocation} onChange={(event) => setToLocation(event.target.value)} required /></Field>
          </div>
          <label className="mv-row"><input type="checkbox" checked={specimenCustody} onChange={(event) => setSpecimenCustody(event.target.checked)} /> Specimen custody chain applies</label>
          <Button type="submit" disabled={action.busy !== null || !fromLocation.trim() || !toLocation.trim() || (requestType === "specimen" && !specimenCustody)}>{action.busy === "create" ? "Requesting…" : "Request porter task"}</Button>
        </form>
      </Card>
      <Card title="Porter tasks">
        {tasks.loading ? <LoadingState /> : tasks.error ? <ErrorState message={tasks.error} onRetry={tasks.reload} /> : !tasks.data?.tasks.length ? <EmptyState title="No porter tasks" description="Request a task above." /> : (
          <Table head={["Route", "Type", "Patient", "Status", ""]} caption="Porter tasks">
            {tasks.data.tasks.map((task) => (
              <tr key={task.id}>
                <td>{task.fromLocation} → {task.toLocation}<div className="mv-small mv-muted">{task.assignedToName ?? "Unassigned"}</div></td>
                <td>{task.requestType}<div className="mv-small mv-muted">{task.specimenCustody ? "custody" : ""}</div></td>
                <td>{task.givenName ? `${task.familyName}, ${task.givenName}` : "—"}</td>
                <td><Badge tone={task.status === "completed" ? "success" : task.status === "cancelled" ? "danger" : "warning"}>{task.status}</Badge></td>
                <td>{nextStatus(task.status) ? <Button size="sm" variant="secondary" onClick={() => void transition(task, nextStatus(task.status)!)} disabled={action.busy !== null}>{nextStatus(task.status)}</Button> : null}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function Mortuary() {
  const cases = useQuery<{ cases: MortuaryCase[] }>("/mortuary/cases");
  const action = useAction();
  const [deceasedName, setDeceasedName] = useState("");
  const [receivedFrom, setReceivedFrom] = useState("");
  const [storageLocation, setStorageLocation] = useState("Mortuary bay 1");
  const [selectedId, setSelectedId] = useState("");

  async function create(event: FormEvent) {
    event.preventDefault();
    await action.run("case", async () => {
      await api("/mortuary/cases", { method: "POST", body: { deceasedName, receivedFrom, storageLocation, identityStatus: "provisional" } });
      setDeceasedName("");
      setReceivedFrom("");
      cases.reload();
      return "Mortuary case created.";
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-grid mv-grid--2">
        <Card title="Receive a case" description="Case references are independent of patient identifiers.">
          <form className="mv-stack" onSubmit={create}>
            <Field label="Deceased name or provisional description" htmlFor="mort-name"><Input id="mort-name" value={deceasedName} onChange={(event) => setDeceasedName(event.target.value)} required minLength={2} /></Field>
            <Field label="Received from" htmlFor="mort-from"><Input id="mort-from" value={receivedFrom} onChange={(event) => setReceivedFrom(event.target.value)} required /></Field>
            <Field label="Storage location" htmlFor="mort-store"><Input id="mort-store" value={storageLocation} onChange={(event) => setStorageLocation(event.target.value)} required /></Field>
            <Button type="submit" disabled={action.busy !== null || !deceasedName.trim() || !receivedFrom.trim()}>{action.busy === "case" ? "Receiving…" : "Receive case"}</Button>
          </form>
        </Card>
        <Card title="Cases in custody">
          {cases.loading ? <LoadingState /> : cases.error ? <ErrorState message={cases.error} onRetry={cases.reload} /> : !cases.data?.cases.length ? <EmptyState title="No cases" description="Receive a case above." /> : (
            <Table head={["Reference", "Name", "Identity", "Status", ""]} caption="Mortuary cases">
              {cases.data.cases.map((row) => (
                <tr key={row.id}>
                  <td className="mv-id">{row.caseRef}</td>
                  <td>{row.deceasedName}<div className="mv-small mv-muted">{row.storageLocation}</div></td>
                  <td><Badge tone={row.identityStatus === "verified" ? "success" : "warning"}>{row.identityStatus}</Badge></td>
                  <td><Badge tone={row.status === "released" ? "success" : "info"}>{row.status}</Badge></td>
                  <td><Button size="sm" variant="secondary" onClick={() => setSelectedId(row.id)}>Open</Button></td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
      {selectedId ? <MortuaryDetail id={selectedId} onClose={() => setSelectedId("")} onChanged={() => cases.reload()} /> : null}
    </div>
  );
}

function MortuaryDetail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const detail = useQuery<{ case: MortuaryCase; movements: { id: string; movementType: string; toLocation: string; occurredAt: string; identityChecked: boolean }[]; effects: { id: string; description: string; quantity: number; custodyStatus: string }[]; release: { id: string; releasedToName: string; relationship: string; releasedAt: string } | null }>(`/mortuary/cases/${id}`);
  const action = useAction();
  const [releasedToName, setReleasedToName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [authorityReference, setAuthorityReference] = useState("");
  const [identificationMethod, setIdentificationMethod] = useState("");
  const [handoverWitness, setHandoverWitness] = useState("");
  const [effectDescription, setEffectDescription] = useState("");

  async function addEffect(event: FormEvent) {
    event.preventDefault();
    await action.run("effect", async () => {
      await api(`/mortuary/cases/${id}/effects`, { method: "POST", body: { description: effectDescription, quantity: 1 } });
      setEffectDescription("");
      detail.reload();
      return "Effect recorded.";
    });
  }

  async function release(event: FormEvent) {
    event.preventDefault();
    await action.run("release", async () => {
      const verifier = detail.data?.case.patientId;
      if (!verifier) throw new Error("A verified patient link is required before release.");
      await api(`/mortuary/cases/${id}/release`, {
        method: "POST",
        body: { releasedToName, relationship, authorityReference, identificationMethod, handoverWitness, identityVerifiedBy: verifier },
      });
      detail.reload();
      onChanged();
      return "Case released with an auditable handover record.";
    });
  }

  if (detail.loading) return <LoadingState />;
  if (detail.error) return <ErrorState message={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return null;

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title={detail.data.case.caseRef} description={`${detail.data.case.deceasedName} · ${detail.data.case.identityStatus} · ${detail.data.case.status}`}>
        <div className="mv-spread"><span className="mv-small mv-muted">{formatDateTime(detail.data.case.receivedAt)}</span><Button size="sm" variant="ghost" onClick={onClose}>Close</Button></div>
      </Card>
      <div className="mv-grid mv-grid--2">
        <Card title="Movements">
          {!detail.data.movements.length ? <EmptyState title="No movements" description="Movements are recorded as the deceased is transferred." /> : (
            <Table head={["Type", "Location", "Identity", "When"]} caption="Mortuary movements">
              {detail.data.movements.map((row) => <tr key={row.id}><td>{row.movementType}</td><td>{row.toLocation}</td><td>{row.identityChecked ? "checked" : "not checked"}</td><td className="mv-small">{formatDateTime(row.occurredAt)}</td></tr>)}
            </Table>
          )}
        </Card>
        <Card title="Property and effects">
          <form className="mv-stack" onSubmit={addEffect}>
            <Field label="Description" htmlFor="effect-desc"><Input id="effect-desc" value={effectDescription} onChange={(event) => setEffectDescription(event.target.value)} required /></Field>
            <Button type="submit" variant="secondary" disabled={action.busy !== null || !effectDescription.trim()}>{action.busy === "effect" ? "Saving…" : "Record effect"}</Button>
          </form>
          {detail.data.effects.length ? <Table head={["Item", "Qty", "Custody"]} caption="Effects">{detail.data.effects.map((row) => <tr key={row.id}><td>{row.description}</td><td>{row.quantity}</td><td>{row.custodyStatus}</td></tr>)}</Table> : null}
        </Card>
      </div>
      <Card title="Release" description="Release requires verified identity, an authority reference and a handover witness.">
        {detail.data.release ? (
          <Notice tone="success">Released to {detail.data.release.releasedToName} ({detail.data.release.relationship}) on {formatDateTime(detail.data.release.releasedAt)}.</Notice>
        ) : (
          <form className="mv-stack" onSubmit={release}>
            <div className="mv-form-grid">
              <Field label="Released to" htmlFor="rel-name"><Input id="rel-name" value={releasedToName} onChange={(event) => setReleasedToName(event.target.value)} required /></Field>
              <Field label="Relationship" htmlFor="rel-rel"><Input id="rel-rel" value={relationship} onChange={(event) => setRelationship(event.target.value)} required /></Field>
              <Field label="Authority reference" htmlFor="rel-auth"><Input id="rel-auth" value={authorityReference} onChange={(event) => setAuthorityReference(event.target.value)} required /></Field>
              <Field label="Identification method" htmlFor="rel-id"><Input id="rel-id" value={identificationMethod} onChange={(event) => setIdentificationMethod(event.target.value)} required /></Field>
              <Field label="Handover witness" htmlFor="rel-witness"><Input id="rel-witness" value={handoverWitness} onChange={(event) => setHandoverWitness(event.target.value)} required /></Field>
            </div>
            <Button type="submit" disabled={action.busy !== null || !releasedToName.trim() || !relationship.trim() || !authorityReference.trim() || !identificationMethod.trim() || !handoverWitness.trim()}>{action.busy === "release" ? "Releasing…" : "Release case"}</Button>
          </form>
        )}
      </Card>
    </div>
  );
}

function Technical() {
  const assets = useQuery<{ assets: Asset[] }>("/technical/assets");
  const workOrders = useQuery<{ workOrders: WorkOrder[] }>("/technical/work-orders");
  const cycles = useQuery<{ cycles: CssdCycle[] }>("/technical/cssd-cycles");
  const action = useAction();
  const [assetRef, setAssetRef] = useState("");
  const [assetName, setAssetName] = useState("");
  const [category, setCategory] = useState("monitoring");
  const [assetId, setAssetId] = useState("");
  const [fault, setFault] = useState("");
  const [priority, setPriority] = useState("routine");
  const [sterilizer, setSterilizer] = useState("Sterilizer 1");
  const [cycleRef, setCycleRef] = useState("");
  const [indicatorResult, setIndicatorResult] = useState("pending");

  async function addAsset(event: FormEvent) {
    event.preventDefault();
    await action.run("asset", async () => {
      await api("/technical/assets", { method: "POST", body: { assetRef, name, category } });
      setAssetRef("");
      setAssetName("");
      assets.reload();
      return "Asset registered.";
    });
  }

  async function addWorkOrder(event: FormEvent) {
    event.preventDefault();
    await action.run("work", async () => {
      await api("/technical/work-orders", { method: "POST", body: { assetId, fault, priority } });
      setFault("");
      workOrders.reload();
      assets.reload();
      return "Work order opened.";
    });
  }

  async function addCycle(event: FormEvent) {
    event.preventDefault();
    await action.run("cycle", async () => {
      await api("/technical/cssd-cycles", { method: "POST", body: { sterilizer, cycleRef, indicatorResult, loadCount: 0 } });
      setCycleRef("");
      cycles.reload();
      return "CSSD cycle recorded.";
    });
  }

  async function releaseCycle(cycle: CssdCycle) {
    await action.run(cycle.id, async () => {
      await api(`/technical/cssd-cycles/${cycle.id}/release`, { method: "POST", body: { releaseNote: "Biological indicator passed; released from CSSD" } });
      cycles.reload();
      return "Cycle released.";
    });
  }

  async function transitionWorkOrder(order: WorkOrder, status: string) {
    await action.run(order.id, async () => {
      await api(`/technical/work-orders/${order.id}/transition`, { method: "POST", body: { status, releaseNote: status === "completed" ? "Repair completed and tested" : undefined } });
      workOrders.reload();
      return `Work order moved to ${status}.`;
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <div className="mv-grid mv-grid--2">
        <Card title="Register an asset">
          <form className="mv-stack" onSubmit={addAsset}>
            <div className="mv-form-grid">
              <Field label="Asset reference" htmlFor="asset-ref"><Input id="asset-ref" value={assetRef} onChange={(event) => setAssetRef(event.target.value)} required /></Field>
              <Field label="Name" htmlFor="asset-name"><Input id="asset-name" value={assetName} onChange={(event) => setAssetName(event.target.value)} required /></Field>
              <Field label="Category" htmlFor="asset-category"><Input id="asset-category" value={category} onChange={(event) => setCategory(event.target.value)} required /></Field>
            </div>
            <Button type="submit" disabled={action.busy !== null || !assetRef.trim() || !assetName.trim()}>{action.busy === "asset" ? "Registering…" : "Register asset"}</Button>
          </form>
        </Card>
        <Card title="Open a maintenance work order">
          <form className="mv-stack" onSubmit={addWorkOrder}>
            <Field label="Asset"><Select value={assetId} onChange={(event) => setAssetId(event.target.value)} required><option value="">Select asset…</option>{assets.data?.assets.map((row) => <option key={row.id} value={row.id}>{row.name} — {row.assetRef}</option>)}</Select></Field>
            <Field label="Fault" htmlFor="wo-fault"><Textarea id="wo-fault" value={fault} onChange={(event) => setFault(event.target.value)} required minLength={5} /></Field>
            <Field label="Priority"><Select value={priority} onChange={(event) => setPriority(event.target.value)}>{["routine", "urgent", "emergency"].map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
            <Button type="submit" disabled={action.busy !== null || !assetId || fault.trim().length < 5}>{action.busy === "work" ? "Opening…" : "Open work order"}</Button>
          </form>
        </Card>
      </div>
      <div className="mv-grid mv-grid--2">
        <Card title="Assets">
          {assets.loading ? <LoadingState /> : assets.error ? <ErrorState message={assets.error} onRetry={assets.reload} /> : !assets.data?.assets.length ? <EmptyState title="No assets" description="Register engineering and biomedical assets first." /> : (
            <Table head={["Asset", "Status", "Open orders"]} caption="Engineering assets">
              {assets.data.assets.map((row) => <tr key={row.id}><td><strong>{row.name}</strong><div className="mv-small mv-muted mv-id">{row.assetRef}</div></td><td>{row.status}</td><td>{row.openWorkOrders}</td></tr>)}
            </Table>
          )}
        </Card>
        <Card title="Work orders">
          {workOrders.loading ? <LoadingState /> : workOrders.error ? <ErrorState message={workOrders.error} onRetry={workOrders.reload} /> : !workOrders.data?.workOrders.length ? <EmptyState title="No work orders" description="Open a work order when an asset needs attention." /> : (
            <Table head={["Asset", "Fault", "Status", ""]} caption="Maintenance work orders">
              {workOrders.data.workOrders.map((row) => (
                <tr key={row.id}><td>{row.assetName}<div className="mv-small mv-muted">{row.priority}</div></td><td>{row.fault}</td><td><Badge tone={row.status === "completed" || row.status === "verified" ? "success" : row.status === "cancelled" ? "danger" : "warning"}>{row.status}</Badge></td><td>{row.status === "open" ? <Button size="sm" variant="secondary" onClick={() => void transitionWorkOrder(row, "in-progress")} disabled={action.busy !== null}>Start</Button> : row.status === "assigned" || row.status === "in-progress" ? <Button size="sm" variant="secondary" onClick={() => void transitionWorkOrder(row, "completed")} disabled={action.busy !== null}>Complete</Button> : null}</td></tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
      <Card title="CSSD sterilization cycles" description="A load cannot be released until the biological indicator passes.">
        <form className="mv-stack" onSubmit={addCycle}>
          <div className="mv-form-grid">
            <Field label="Sterilizer" htmlFor="cssd-sterilizer"><Input id="cssd-sterilizer" value={sterilizer} onChange={(event) => setSterilizer(event.target.value)} required /></Field>
            <Field label="Cycle reference" htmlFor="cssd-ref"><Input id="cssd-ref" value={cycleRef} onChange={(event) => setCycleRef(event.target.value)} required /></Field>
            <Field label="Indicator result"><Select value={indicatorResult} onChange={(event) => setIndicatorResult(event.target.value)}>{["pending", "pass", "fail"].map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
          </div>
          <Button type="submit" variant="secondary" disabled={action.busy !== null || !cycleRef.trim()}>{action.busy === "cycle" ? "Recording…" : "Record cycle"}</Button>
        </form>
        {cycles.loading ? <LoadingState /> : cycles.error ? <ErrorState message={cycles.error} onRetry={cycles.reload} /> : !cycles.data?.cycles.length ? <EmptyState title="No cycles" description="Record a sterilization cycle to begin tracking a load." /> : (
          <Table head={["Cycle", "Sterilizer", "Indicator", "Status", ""]} caption="CSSD cycles">
            {cycles.data.cycles.map((row) => (
              <tr key={row.id}><td className="mv-id">{row.cycleRef}</td><td>{row.sterilizer}</td><td><Badge tone={row.indicatorResult === "pass" ? "success" : row.indicatorResult === "fail" ? "danger" : "warning"}>{row.indicatorResult}</Badge></td><td>{row.status}</td><td>{row.status === "quarantined" && row.indicatorResult === "pass" ? <Button size="sm" variant="secondary" onClick={() => void releaseCycle(row)} disabled={action.busy !== null}>Release</Button> : null}</td></tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
