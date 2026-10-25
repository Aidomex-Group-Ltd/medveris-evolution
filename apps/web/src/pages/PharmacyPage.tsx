import { useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDate, formatDateTime, futureIso, todayInput } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { EncounterPicker, MemberPicker, PatientPicker } from "../components/Pickers";

interface Medicine { id: string; name: string; strength: string; form: string; route: string; stockQuantity: number }
interface Review { decision: string; note: string }
interface Order { id: string; patientId: string; encounterId: string; medicineId: string; doseText: string; route: string; frequency: string; durationDays: number | null; status: string; version: number; publicId: string; givenName: string; familyName: string; medicineName: string; strength: string; form: string; orderedByName: string; createdAt: string; latestReview: Review | null }
interface Lot { id: string; medicineId: string; lotNumber: string; expiresOn: string; quantity: number; location: string; version: number; medicineName: string; strength: string; form: string; expired: boolean }
interface Administration { id: string; orderId: string; doseText: string; administeredAt: string; site: string | null; notes: string | null; status: string; administeredByName: string }
interface MedicationHistory { orders: Order[]; administrations: Administration[] }

export function PharmacyPage() {
  const { me } = useAuth();
  const roles = me?.activeTenant?.roles ?? [];
  const pharmacist = roles.includes("pharmacist");
  const clinician = roles.some((role) => ["clinician", "nurse"].includes(role));
  const [tab, setTab] = useState<"orders" | "stock" | "catalogue" | "patient">("orders");
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Pharmacy" title="Medication, stock and administration" description="Prescribing, pharmacist review, dispensing and administration are separate audited steps." />
      <Tabs label="Pharmacy sections" value={tab} onChange={setTab} options={[{ value: "orders", label: "Prescriptions" }, { value: "stock", label: "Stock" }, { value: "catalogue", label: "Catalogue" }, { value: "patient", label: "Patient history" }]} />
      {tab === "orders" ? <Orders pharmacist={pharmacist} clinician={clinician} /> : null}
      {tab === "stock" ? <Stock pharmacist={pharmacist} /> : null}
      {tab === "catalogue" ? <Catalogue pharmacist={pharmacist} /> : null}
      {tab === "patient" ? <PatientHistory clinician={clinician} /> : null}
    </div>
  );
}

function Orders({ pharmacist, clinician }: { pharmacist: boolean; clinician: boolean }) {
  const orders = useQuery<{ orders: Order[] }>("/medication-orders");
  const medicines = useQuery<{ medicines: Medicine[] }>("/medicines");
  const [showForm, setShowForm] = useState(false);
  const [patientId, setPatientId] = useState("");
  const [encounterId, setEncounterId] = useState("");
  const [medicineId, setMedicineId] = useState("");
  const [doseText, setDoseText] = useState("");
  const [route, setRoute] = useState("");
  const [frequency, setFrequency] = useState("");
  const [durationDays, setDurationDays] = useState("");
  const action = useAction();

  async function order(event: FormEvent) {
    event.preventDefault();
    await action.run("order", async () => {
      await api("/medication-orders", { method: "POST", body: { patientId, encounterId, medicineId, doseText, route, frequency, durationDays: durationDays ? Number(durationDays) : null } });
      setDoseText("");
      setShowForm(false);
      orders.reload();
      return "Medication order submitted for pharmacist review.";
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {clinician ? <div className="mv-row" style={{ justifyContent: "flex-end" }}><Button onClick={() => setShowForm((prev) => !prev)}>{showForm ? "Close form" : "New prescription"}</Button></div> : null}
      {showForm && clinician ? (
        <Card title="New medication order" description="Orders start as pending review and cannot be dispensed until a pharmacist approves them.">
          <form className="mv-stack" onSubmit={order}>
            <div className="mv-form-grid">
              <PatientPicker value={patientId} onChange={(value) => { setPatientId(value); setEncounterId(""); }} />
              <EncounterPicker value={encounterId} onChange={setEncounterId} patientId={patientId || undefined} />
              <Field label="Medicine"><Select value={medicineId} onChange={(event) => { setMedicineId(event.target.value); const med = medicines.data?.medicines.find((row) => row.id === event.target.value); setRoute(med?.route ?? route); }} required><option value="">Select a medicine…</option>{medicines.data?.medicines.map((med) => <option key={med.id} value={med.id}>{med.name} {med.strength} ({med.form})</option>)}</Select></Field>
              <Field label="Dose" htmlFor="dose-text"><Input id="dose-text" value={doseText} onChange={(event) => setDoseText(event.target.value)} required /></Field>
              <Field label="Route" htmlFor="dose-route"><Input id="dose-route" value={route} onChange={(event) => setRoute(event.target.value)} required /></Field>
              <Field label="Frequency" htmlFor="dose-frequency"><Input id="dose-frequency" value={frequency} onChange={(event) => setFrequency(event.target.value)} required placeholder="e.g. twice daily" /></Field>
              <Field label="Duration (days)" htmlFor="dose-duration"><Input id="dose-duration" type="number" min={1} max={365} value={durationDays} onChange={(event) => setDurationDays(event.target.value)} /></Field>
            </div>
            <Button type="submit" disabled={action.busy !== null || !patientId || !encounterId || !medicineId || !doseText || !route || !frequency}>{action.busy === "order" ? "Submitting…" : "Submit order"}</Button>
          </form>
        </Card>
      ) : null}
      <Card title="Prescription worklist">
        {orders.loading ? <LoadingState /> : orders.error ? <ErrorState message={orders.error} onRetry={orders.reload} /> : !orders.data?.orders.length ? <EmptyState title="No medication orders" description={clinician ? "Create a prescription from an active encounter." : "No prescriptions are awaiting pharmacy action."} /> : (
          <div className="mv-stack">
            {orders.data.orders.map((order) => (
              <div key={order.id} className="mv-note">
                <div className="mv-spread">
                  <div><strong>{order.givenName} {order.familyName}</strong> <span className="mv-small mv-muted mv-id">{order.publicId}</span><div>{order.medicineName} {order.strength} · {order.doseText} · {order.route} · {order.frequency}{order.durationDays ? ` for ${order.durationDays} days` : ""}</div></div>
                  <Badge tone={order.status === "approved" || order.status === "active" ? "success" : order.status === "rejected" ? "danger" : "warning"}>{order.status}</Badge>
                </div>
                <div className="mv-small mv-muted">Ordered by {order.orderedByName} · {formatDateTime(order.createdAt)}{order.latestReview ? ` · last review: ${order.latestReview.decision}` : ""}</div>
                {pharmacist && order.status === "pending-review" ? <ReviewForm orderId={order.id} onDone={orders.reload} /> : null}
                {pharmacist && order.status === "approved" ? <DispenseForm order={order} onDone={orders.reload} /> : null}
                {order.status === "active" && clinician ? <AdministrationForm order={order} onDone={orders.reload} /> : null}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function ReviewForm({ orderId, onDone }: { orderId: string; onDone: () => void }) {
  const [decision, setDecision] = useState("approved");
  const [note, setNote] = useState("");
  const action = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run("review", async () => {
      await api(`/medication-orders/${orderId}/review`, { method: "POST", body: { decision, note } });
      onDone();
      return `Order ${decision}.`;
    });
  }
  return (
    <form className="mv-stack mv-note" onSubmit={submit} style={{ marginTop: 8 }}>
      {action.error ? <ErrorState message={action.error} /> : null}
      <div className="mv-form-grid">
        <Field label="Review decision"><Select value={decision} onChange={(event) => setDecision(event.target.value)}><option value="approved">Approve</option><option value="rejected">Reject</option></Select></Field>
        <Field label="Review note" htmlFor={`review-${orderId}`}><Input id={`review-${orderId}`} value={note} onChange={(event) => setNote(event.target.value)} required minLength={5} /></Field>
      </div>
      <Button size="sm" type="submit" disabled={action.busy !== null || note.trim().length < 5}>{action.busy === "review" ? "Recording…" : "Record review"}</Button>
    </form>
  );
}

function DispenseForm({ order, onDone }: { order: Order; onDone: () => void }) {
  const lots = useQuery<{ lots: Lot[] }>("/stock/lots");
  const [lotId, setLotId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [notes, setNotes] = useState("");
  const action = useAction();
  const available = (lots.data?.lots ?? []).filter((lot) => lot.medicineId === order.medicineId && Number(lot.quantity) > 0 && !lot.expired);
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run("dispense", async () => {
      await api("/dispenses", { method: "POST", body: { orderId: order.id, lotId, quantity: Number(quantity), notes } });
      onDone();
      return "Medication dispensed from the selected lot.";
    });
  }
  return (
    <form className="mv-stack mv-note" onSubmit={submit} style={{ marginTop: 8 }}>
      {action.error ? <ErrorState message={action.error} /> : null}
      {!available.length ? <Notice tone="warning">No non-expired stock lot is available for this medicine. Receive stock first.</Notice> : null}
      <div className="mv-form-grid">
        <Field label="Stock lot"><Select value={lotId} onChange={(event) => setLotId(event.target.value)} required disabled={!available.length}><option value="">Select a lot…</option>{available.map((lot) => <option key={lot.id} value={lot.id}>{lot.lotNumber} — {formatDate(lot.expiresOn)} · {lot.quantity} available</option>)}</Select></Field>
        <Field label="Quantity" htmlFor={`dispense-qty-${order.id}`}><Input id={`dispense-qty-${order.id}`} type="number" min={0.01} step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} required /></Field>
        <Field label="Notes" htmlFor={`dispense-notes-${order.id}`}><Input id={`dispense-notes-${order.id}`} value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
      </div>
      <Button size="sm" type="submit" disabled={action.busy !== null || !lotId || Number(quantity) <= 0}>{action.busy === "dispense" ? "Dispensing…" : "Dispense"}</Button>
    </form>
  );
}

function AdministrationForm({ order, onDone }: { order: Order; onDone: () => void }) {
  const [doseText, setDoseText] = useState(order.doseText);
  const [administeredAt, setAdministeredAt] = useState(new Date().toISOString().slice(0, 16));
  const [site, setSite] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState("administered");
  const [witness, setWitness] = useState("");
  const action = useAction();
  async function submit(event: FormEvent) {
    event.preventDefault();
    await action.run("administer", async () => {
      await api("/medication-administrations", {
        method: "POST",
        body: { orderId: order.id, doseText, administeredAt: new Date(administeredAt).toISOString(), site, notes, status, witnessedBy: witness || null },
      });
      onDone();
      return "Medication administration recorded.";
    });
  }
  return (
    <form className="mv-stack mv-note" onSubmit={submit} style={{ marginTop: 8 }}>
      {action.error ? <ErrorState message={action.error} /> : null}
      <div className="mv-form-grid">
        <Field label="Dose administered" htmlFor={`admin-dose-${order.id}`}><Input id={`admin-dose-${order.id}`} value={doseText} onChange={(event) => setDoseText(event.target.value)} required /></Field>
        <Field label="Administered at" htmlFor={`admin-time-${order.id}`}><Input id={`admin-time-${order.id}`} type="datetime-local" value={administeredAt} onChange={(event) => setAdministeredAt(event.target.value)} required /></Field>
        <Field label="Outcome"><Select value={status} onChange={(event) => setStatus(event.target.value)}><option value="administered">Administered</option><option value="refused">Refused</option><option value="held">Held</option></Select></Field>
        <Field label="Site" htmlFor={`admin-site-${order.id}`}><Input id={`admin-site-${order.id}`} value={site} onChange={(event) => setSite(event.target.value)} /></Field>
        <MemberPicker value={witness} onChange={setWitness} label="Witness (optional)" id={`witness-${order.id}`} required={false} />
        <Field label="Notes" htmlFor={`admin-notes-${order.id}`}><Input id={`admin-notes-${order.id}`} value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
      </div>
      <Button size="sm" type="submit" disabled={action.busy !== null || !doseText || !administeredAt}>{action.busy === "administer" ? "Recording…" : "Record administration"}</Button>
    </form>
  );
}

function Stock({ pharmacist }: { pharmacist: boolean }) {
  const lots = useQuery<{ lots: Lot[] }>("/stock/lots");
  const medicines = useQuery<{ medicines: Medicine[] }>("/medicines");
  const action = useAction();
  const [medicineId, setMedicineId] = useState("");
  const [lotNumber, setLotNumber] = useState("");
  const [expiresOn, setExpiresOn] = useState(futureIso(180).slice(0, 10));
  const [quantity, setQuantity] = useState("");
  const [location, setLocation] = useState("Pharmacy store");
  const [movementLot, setMovementLot] = useState("");
  const [delta, setDelta] = useState("");
  const [movementReason, setMovementReason] = useState("");

  async function receive(event: FormEvent) {
    event.preventDefault();
    await action.run("lot", async () => {
      await api("/stock/lots", { method: "POST", body: { medicineId, lotNumber, expiresOn, quantity: Number(quantity), location } });
      setLotNumber("");
      setQuantity("");
      lots.reload();
      medicines.reload();
      return "Stock lot received.";
    });
  }

  async function adjust(event: FormEvent) {
    event.preventDefault();
    await action.run("movement", async () => {
      await api("/stock/movements", { method: "POST", body: { lotId: movementLot, delta: Number(delta), reason: movementReason } });
      setDelta("");
      setMovementReason("");
      lots.reload();
      medicines.reload();
      return "Stock movement recorded.";
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Stock lots" description="Expired lots are highlighted and cannot be dispensed.">
        {lots.loading ? <LoadingState /> : lots.error ? <ErrorState message={lots.error} onRetry={lots.reload} /> : !lots.data?.lots.length ? <EmptyState title="No stock" description="Receive a stock lot to begin dispensing." /> : (
          <Table head={["Medicine", "Lot", "Expires", "Quantity", "Location", "Status"]} caption="Pharmacy stock">
            {lots.data.lots.map((lot) => (
              <tr key={lot.id}>
                <td><strong>{lot.medicineName}</strong> {lot.strength}<div className="mv-small mv-muted">{lot.form}</div></td>
                <td>{lot.lotNumber}</td>
                <td>{formatDate(lot.expiresOn)}</td>
                <td>{lot.quantity}</td>
                <td>{lot.location}</td>
                <td><Badge tone={lot.expired ? "danger" : Number(lot.quantity) === 0 ? "warning" : "success"}>{lot.expired ? "expired" : Number(lot.quantity) === 0 ? "empty" : "in stock"}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {pharmacist ? (
        <div className="mv-grid mv-grid--2">
          <Card title="Receive stock lot">
            <form className="mv-stack" onSubmit={receive}>
              <Field label="Medicine"><Select value={medicineId} onChange={(event) => setMedicineId(event.target.value)} required><option value="">Select a medicine…</option>{medicines.data?.medicines.map((med) => <option key={med.id} value={med.id}>{med.name} {med.strength}</option>)}</Select></Field>
              <div className="mv-form-grid">
                <Field label="Lot number" htmlFor="lot-number"><Input id="lot-number" value={lotNumber} onChange={(event) => setLotNumber(event.target.value)} required /></Field>
                <Field label="Expires on" htmlFor="lot-expiry"><Input id="lot-expiry" type="date" min={todayInput()} value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} required /></Field>
                <Field label="Quantity" htmlFor="lot-quantity"><Input id="lot-quantity" type="number" min={0} step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} required /></Field>
                <Field label="Location" htmlFor="lot-location"><Input id="lot-location" value={location} onChange={(event) => setLocation(event.target.value)} required /></Field>
              </div>
              <Button type="submit" disabled={action.busy !== null || !medicineId || !lotNumber || !quantity}>{action.busy === "lot" ? "Receiving…" : "Receive lot"}</Button>
            </form>
          </Card>
          <Card title="Adjust stock" description="Adjustments require a reason and are audited.">
            <form className="mv-stack" onSubmit={adjust}>
              <Field label="Lot"><Select value={movementLot} onChange={(event) => setMovementLot(event.target.value)} required><option value="">Select a lot…</option>{lots.data?.lots.map((lot) => <option key={lot.id} value={lot.id}>{lot.medicineName} · {lot.lotNumber} · {lot.quantity}</option>)}</Select></Field>
              <Field label="Delta (positive or negative)" htmlFor="stock-delta"><Input id="stock-delta" type="number" step="any" value={delta} onChange={(event) => setDelta(event.target.value)} required /></Field>
              <Field label="Reason" htmlFor="stock-reason"><Textarea id="stock-reason" value={movementReason} onChange={(event) => setMovementReason(event.target.value)} required minLength={3} /></Field>
              <Button type="submit" variant="secondary" disabled={action.busy !== null || !movementLot || !delta || movementReason.trim().length < 3}>{action.busy === "movement" ? "Adjusting…" : "Record adjustment"}</Button>
            </form>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

function Catalogue({ pharmacist }: { pharmacist: boolean }) {
  const medicines = useQuery<{ medicines: Medicine[] }>("/medicines");
  const action = useAction();
  const [name, setName] = useState("");
  const [strength, setStrength] = useState("");
  const [form, setForm] = useState("");
  const [route, setRoute] = useState("");
  const [code, setCode] = useState("");
  const [codeSystem, setCodeSystem] = useState("");
  const [codeVersion, setCodeVersion] = useState("");
  const [knowledgeSource, setKnowledgeSource] = useState("");

  async function create(event: FormEvent) {
    event.preventDefault();
    await action.run("medicine", async () => {
      await api("/medicines", { method: "POST", body: { name, strength, form, route, code, codeSystem, codeVersion, knowledgeSource } });
      setName("");
      setStrength("");
      medicines.reload();
      return "Medicine added to the local catalogue.";
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Medicine catalogue" description="Local catalogue entries. Coding and knowledge-source metadata are optional and must not be invented.">
        {medicines.loading ? <LoadingState /> : medicines.error ? <ErrorState message={medicines.error} onRetry={medicines.reload} /> : !medicines.data?.medicines.length ? <EmptyState title="No medicines" description="A pharmacist must add a medicine to the catalogue." /> : (
          <Table head={["Medicine", "Strength", "Form", "Route", "On hand"]} caption="Medicine catalogue">
            {medicines.data.medicines.map((med) => <tr key={med.id}><td>{med.name}</td><td>{med.strength}</td><td>{med.form}</td><td>{med.route}</td><td>{med.stockQuantity}</td></tr>)}
          </Table>
        )}
      </Card>
      {pharmacist ? (
        <Card title="Add a medicine">
          <form className="mv-stack" onSubmit={create}>
            <div className="mv-form-grid">
              <Field label="Name" htmlFor="med-name"><Input id="med-name" value={name} onChange={(event) => setName(event.target.value)} required minLength={2} /></Field>
              <Field label="Strength" htmlFor="med-strength"><Input id="med-strength" value={strength} onChange={(event) => setStrength(event.target.value)} required /></Field>
              <Field label="Form" htmlFor="med-form"><Input id="med-form" value={form} onChange={(event) => setForm(event.target.value)} required /></Field>
              <Field label="Route" htmlFor="med-route"><Input id="med-route" value={route} onChange={(event) => setRoute(event.target.value)} required /></Field>
              <Field label="Code system URL"><Input type="url" value={codeSystem} onChange={(event) => setCodeSystem(event.target.value)} /></Field>
              <Field label="Code version"><Input value={codeVersion} onChange={(event) => setCodeVersion(event.target.value)} /></Field>
              <Field label="Code"><Input value={code} onChange={(event) => setCode(event.target.value)} /></Field>
              <Field label="Knowledge source"><Input value={knowledgeSource} onChange={(event) => setKnowledgeSource(event.target.value)} /></Field>
            </div>
            <Button type="submit" disabled={action.busy !== null || !name || !strength || !form || !route}>{action.busy === "medicine" ? "Adding…" : "Add medicine"}</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

function PatientHistory({ clinician }: { clinician: boolean }) {
  const [patientId, setPatientId] = useState("");
  const history = useQuery<MedicationHistory>(patientId ? `/patients/${patientId}/medication` : null);
  return (
    <div className="mv-stack">
      <Card title="Medication history"><PatientPicker value={patientId} onChange={setPatientId} required={false} /></Card>
      {!patientId ? <EmptyState title="No patient selected" description="Choose a patient to review orders and administrations." /> : history.loading ? <LoadingState /> : history.error ? <ErrorState message={history.error} onRetry={history.reload} /> : (
        <div className="mv-grid mv-grid--2">
          <Card title="Medication orders">
            {!history.data?.orders.length ? <EmptyState title="No orders" description="No medication orders recorded." /> : (
              <div className="mv-stack">
                {history.data.orders.map((order) => (
                  <div key={order.id} className="mv-note">
                    <div className="mv-spread"><strong>{order.medicineName}</strong><Badge tone={order.status === "active" ? "success" : order.status === "rejected" ? "danger" : "warning"}>{order.status}</Badge></div>
                    <div>{order.doseText} · {order.route} · {order.frequency}</div>
                    <div className="mv-small mv-muted">{formatDateTime(order.createdAt)}</div>
                    {order.status === "active" && clinician ? <AdministrationForm order={order} onDone={() => history.reload()} /> : null}
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card title="Administrations">
            {!history.data?.administrations.length ? <EmptyState title="No administrations" description="No administration events recorded." /> : (
              <Table head={["Dose", "Status", "When", "By"]} caption="Medication administrations">
                {history.data.administrations.map((row) => <tr key={row.id}><td>{row.doseText}{row.site ? <div className="mv-small mv-muted">{row.site}</div> : null}</td><td><Badge tone={row.status === "administered" ? "success" : "warning"}>{row.status}</Badge></td><td className="mv-small">{formatDateTime(row.administeredAt)}</td><td className="mv-small">{row.administeredByName}</td></tr>)}
              </Table>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
