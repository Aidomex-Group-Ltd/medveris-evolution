import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { EncounterPicker, PatientPicker } from "../components/Pickers";

interface Order { id: string; patientId: string; orderType: string; priority: string; clinicalNote: string; status: string; version: number; publicId: string; givenName: string; familyName: string; itemCount: number; createdAt: string; orderedByName: string }
interface LabTest { id: string; name: string; specimenType: string; loincCode: string }
interface PatientSummary { id: string; publicId: string; givenName: string; familyName: string }
interface PatientDiagnostics { results: Array<{ id: string; testName: string; status: string; valueText: string | null; valueNum: string | null; unitCode: string | null; referenceRange: string | null; interpretation: string; critical: boolean; createdAt: string }>; reports: Array<{ id: string; studyName: string; status: string; impression: string; critical: boolean; createdAt: string }> }

interface DraftItem { labTestId: string; name: string; specimenType: string }

export function DiagnosticsPage() {
  const [tab, setTab] = useState<"orders" | "patient">("orders");
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Diagnostics" title="Laboratory and imaging orders" description="Results are versioned, verified and audited. Critical results must be communicated to an identified recipient." />
      <Tabs label="Diagnostics sections" value={tab} onChange={setTab} options={[{ value: "orders", label: "Orders" }, { value: "patient", label: "Patient results" }]} />
      {tab === "orders" ? <Orders /> : <PatientResults />}
    </div>
  );
}

function Orders() {
  const [statusFilter, setStatusFilter] = useState("");
  const orders = useQuery<{ orders: Order[] }>(`/diagnostic-orders${statusFilter ? `?status=${statusFilter}` : ""}`);
  const tests = useQuery<{ tests: LabTest[] }>("/lab-tests");
  const action = useAction();
  const [showForm, setShowForm] = useState(false);
  const [patientId, setPatientId] = useState("");
  const [encounterId, setEncounterId] = useState("");
  const [orderType, setOrderType] = useState("laboratory");
  const [priority, setPriority] = useState("routine");
  const [note, setNote] = useState("");
  const [items, setItems] = useState<DraftItem[]>([{ labTestId: "", name: "", specimenType: "" }]);

  function updateItem(index: number, patch: Partial<DraftItem>) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const payloadItems = items.filter((item) => item.name.trim()).map((item) => ({
      labTestId: item.labTestId || null,
      name: item.name.trim(),
      specimenType: item.specimenType.trim(),
    }));
    if (!payloadItems.length) {
      action.setError("Add at least one order item.");
      return;
    }
    await action.run("create", async () => {
      const result = await api<{ order: { id: string } }>("/diagnostic-orders", {
        method: "POST",
        body: { patientId, encounterId, orderType, priority, clinicalNote: note, items: payloadItems },
      });
      setShowForm(false);
      setNote("");
      setItems([{ labTestId: "", name: "", specimenType: "" }]);
      orders.reload();
      return `Order placed. Open ${result.order.id.slice(0, 8)} to progress the workflow.`;
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Order worklist" actions={<div className="mv-row"><Select aria-label="Filter by order status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All statuses</option><option value="ordered">Ordered</option><option value="collected">Collected</option><option value="in-progress">In progress</option><option value="resulted">Resulted</option><option value="cancelled">Cancelled</option></Select><Button onClick={() => setShowForm((prev) => !prev)}>{showForm ? "Close form" : "New order"}</Button></div>}>
        {orders.loading ? <LoadingState /> : orders.error ? <ErrorState message={orders.error} onRetry={orders.reload} /> : !orders.data?.orders.length ? <EmptyState title="No diagnostic orders" description="Place a laboratory or imaging order from an active encounter." /> : (
          <Table head={["Patient", "Type", "Priority", "Status", "Items", "Ordered", ""]} caption="Diagnostic orders">
            {orders.data.orders.map((order) => (
              <tr key={order.id}>
                <td><strong>{order.givenName} {order.familyName}</strong><div className="mv-small mv-muted mv-id">{order.publicId}</div></td>
                <td>{order.orderType}</td>
                <td><Badge tone={order.priority === "emergency" ? "danger" : order.priority === "urgent" ? "warning" : "neutral"}>{order.priority}</Badge></td>
                <td><Badge tone={order.status === "resulted" ? "success" : order.status === "cancelled" ? "neutral" : "info"}>{order.status}</Badge></td>
                <td>{order.itemCount}</td>
                <td className="mv-small">{formatDateTime(order.createdAt)}<div className="mv-muted">{order.orderedByName}</div></td>
                <td><Link className="mv-button mv-button--secondary mv-button--sm" to={`/diagnostics/orders/${order.id}`}>Open</Link></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {showForm ? (
        <Card title="Place a diagnostic order" description="Laboratory items may reference a configured test; imaging items are free-text requests.">
          <form className="mv-stack" onSubmit={submit}>
            <div className="mv-form-grid">
              <PatientPicker value={patientId} onChange={(value) => { setPatientId(value); setEncounterId(""); }} />
              <EncounterPicker value={encounterId} onChange={setEncounterId} patientId={patientId || undefined} />
              <Field label="Order type"><Select value={orderType} onChange={(event) => setOrderType(event.target.value)}><option value="laboratory">Laboratory</option><option value="imaging">Imaging</option><option value="other">Other</option></Select></Field>
              <Field label="Priority"><Select value={priority} onChange={(event) => setPriority(event.target.value)}><option value="routine">Routine</option><option value="urgent">Urgent</option><option value="emergency">Emergency</option></Select></Field>
            </div>
            <Field label="Clinical note" htmlFor="order-note"><Textarea id="order-note" value={note} onChange={(event) => setNote(event.target.value)} required minLength={2} /></Field>
            <div className="mv-stack">
              {items.map((item, index) => (
                <div key={index} className="mv-note">
                  <div className="mv-form-grid">
                    {orderType === "laboratory" ? (
                      <Field label="Catalogue test">
                        <Select value={item.labTestId} onChange={(event) => {
                          const test = tests.data?.tests.find((row) => row.id === event.target.value);
                          updateItem(index, { labTestId: event.target.value, name: test?.name ?? item.name, specimenType: test?.specimenType ?? item.specimenType });
                        }}>
                          <option value="">Custom / not listed</option>
                          {tests.data?.tests.map((test) => <option key={test.id} value={test.id}>{test.name} ({test.loincCode})</option>)}
                        </Select>
                      </Field>
                    ) : null}
                    <Field label="Item name"><Input value={item.name} onChange={(event) => updateItem(index, { name: event.target.value })} required /></Field>
                    {orderType === "laboratory" ? <Field label="Specimen type"><Input value={item.specimenType} onChange={(event) => updateItem(index, { specimenType: event.target.value })} /></Field> : null}
                  </div>
                  {items.length > 1 ? <Button size="sm" variant="ghost" onClick={() => setItems((prev) => prev.filter((_, i) => i !== index))}>Remove item</Button> : null}
                </div>
              ))}
            </div>
            <div className="mv-row">
              <Button variant="secondary" onClick={() => setItems((prev) => [...prev, { labTestId: "", name: "", specimenType: "" }])}>Add item</Button>
              <Button type="submit" disabled={action.busy !== null || !patientId || !encounterId || note.trim().length < 2}>{action.busy === "create" ? "Placing…" : "Place order"}</Button>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

function PatientResults() {
  const [patientId, setPatientId] = useState("");
  const summary = useQuery<PatientDiagnostics>(patientId ? `/patients/${patientId}/diagnostics` : null);
  const patients = useQuery<{ patients: PatientSummary[] }>("/patients/recent");
  const selected = patients.data?.patients.find((patient) => patient.id === patientId);
  return (
    <div className="mv-stack">
      <Card title="Patient diagnostic summary" description="Select a patient to review finalized, corrected and preliminary results recorded by this facility.">
        <PatientPicker value={patientId} onChange={setPatientId} label="Patient" required={false} />
      </Card>
      {!patientId ? <EmptyState title="No patient selected" description="Choose a patient to view their diagnostic record." /> : summary.loading ? <LoadingState /> : summary.error ? <ErrorState message={summary.error} onRetry={summary.reload} /> : (
        <div className="mv-grid mv-grid--2">
          <Card title={`Laboratory results${selected ? ` — ${selected.givenName} ${selected.familyName}` : ""}`}>
            {!summary.data?.results.length ? <EmptyState title="No results" description="No laboratory results recorded for this patient." /> : (
              <Table head={["Test", "Result", "Status", "Interpretation"]} caption="Laboratory results">
                {summary.data.results.map((result) => (
                  <tr key={result.id}>
                    <td><strong>{result.testName}</strong><div className="mv-small mv-muted">{formatDateTime(result.createdAt)}</div></td>
                    <td>{result.valueText ?? result.valueNum ?? "—"} {result.unitCode ?? ""}{result.referenceRange ? <div className="mv-small mv-muted">ref {result.referenceRange}</div> : null}</td>
                    <td><Badge tone={result.critical ? "danger" : result.status === "final" ? "success" : "warning"}>{result.status}</Badge></td>
                    <td>{result.interpretation}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          <Card title="Imaging reports">
            {!summary.data?.reports.length ? <EmptyState title="No reports" description="No diagnostic reports recorded for this patient." /> : (
              <div className="mv-stack">
                {summary.data.reports.map((report) => (
                  <div key={report.id} className="mv-note">
                    <div className="mv-spread"><strong>{report.studyName}</strong><Badge tone={report.critical ? "danger" : "neutral"}>{report.status}</Badge></div>
                    <p>{report.impression}</p>
                    <div className="mv-small mv-muted">{formatDateTime(report.createdAt)}</div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
