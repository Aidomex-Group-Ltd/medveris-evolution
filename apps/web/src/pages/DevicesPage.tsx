import { useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Table, Tabs } from "@medveris/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { EncounterPicker, PatientPicker } from "../components/Pickers";

interface Assignment { id: string; patient_id: string; encounter_id: string }
interface Device { id: string; serial: string; manufacturer: string; model: string; firmware: string | null; site: string | null; status: string; lastSeenAt: string | null; activeAssignment: Assignment | null }
interface Alert { id: string; severity: string; message: string; createdAt: string; measuredAt: string; nativeCode: string; valueNum: string | number; unitCode: string; publicId: string; givenName: string; familyName: string; serial: string; manufacturer: string; model: string }

interface MetricDraft { nativeCode: string; loincSystem: string; loincVersion: string; loincCode: string; display: string; unitCode: string }

export function DevicesPage() {
  const { me } = useAuth();
  const roles = me?.activeTenant?.roles ?? [];
  const admin = roles.includes("facility_admin");
  const clinical = roles.some((role) => ["clinician", "nurse"].includes(role));
  const [tab, setTab] = useState<"devices" | "alerts">("devices");
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Devices" title="Connected device registry" description="Device mappings are reviewed before use. Ingestion is disabled because the device integration is not configured." />
      <Notice tone="warning">Device ingestion is disabled in this environment. The registry, assignments and alert acknowledgement work; no vital-sign observations can be ingested or simulated here.</Notice>
      <Tabs label="Device sections" value={tab} onChange={setTab} options={[{ value: "devices", label: "Devices" }, { value: "alerts", label: "Alerts" }]} />
      {tab === "devices" ? <DeviceList admin={admin} clinical={clinical} /> : <Alerts clinical={clinical} />}
    </div>
  );
}

function DeviceList({ admin, clinical }: { admin: boolean; clinical: boolean }) {
  const devices = useQuery<{ devices: Device[] }>("/devices");
  const [showForm, setShowForm] = useState(false);
  const [serial, setSerial] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [model, setModel] = useState("");
  const [firmware, setFirmware] = useState("");
  const [site, setSite] = useState("");
  const [metrics, setMetrics] = useState<MetricDraft[]>([{ nativeCode: "", loincSystem: "http://loinc.org", loincVersion: "", loincCode: "", display: "", unitCode: "" }]);
  const action = useAction();

  function updateMetric(index: number, patch: Partial<MetricDraft>) {
    setMetrics((prev) => prev.map((metric, i) => (i === index ? { ...metric, ...patch } : metric)));
  }

  async function register(event: FormEvent) {
    event.preventDefault();
    const supportedMetrics = metrics.filter((metric) => metric.nativeCode && metric.loincCode && metric.display);
    await action.run("register", async () => {
      await api("/devices", { method: "POST", body: { serial, manufacturer, model, firmware, site, supportedMetrics } });
      setShowForm(false);
      setSerial("");
      setMetrics([{ nativeCode: "", loincSystem: "http://loinc.org", loincVersion: "", loincCode: "", display: "", unitCode: "" }]);
      devices.reload();
      return "Device registered.";
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {admin ? <div className="mv-row" style={{ justifyContent: "flex-end" }}><Button onClick={() => setShowForm((prev) => !prev)}>{showForm ? "Close form" : "Register device"}</Button></div> : null}
      {showForm && admin ? (
        <Card title="Register a device" description="Each supported native metric must have a reviewed LOINC mapping with an explicit unit.">
          <form className="mv-stack" onSubmit={register}>
            <div className="mv-form-grid">
              <Field label="Serial" htmlFor="device-serial"><Input id="device-serial" value={serial} onChange={(event) => setSerial(event.target.value)} required minLength={3} /></Field>
              <Field label="Manufacturer" htmlFor="device-manufacturer"><Input id="device-manufacturer" value={manufacturer} onChange={(event) => setManufacturer(event.target.value)} required minLength={2} /></Field>
              <Field label="Model" htmlFor="device-model"><Input id="device-model" value={model} onChange={(event) => setModel(event.target.value)} required /></Field>
              <Field label="Firmware" htmlFor="device-firmware"><Input id="device-firmware" value={firmware} onChange={(event) => setFirmware(event.target.value)} /></Field>
              <Field label="Site" htmlFor="device-site"><Input id="device-site" value={site} onChange={(event) => setSite(event.target.value)} /></Field>
            </div>
            <strong>Supported metrics</strong>
            {metrics.map((metric, index) => (
              <div key={index} className="mv-note">
                <div className="mv-form-grid">
                  <Field label="Native code"><Input value={metric.nativeCode} onChange={(event) => updateMetric(index, { nativeCode: event.target.value })} required /></Field>
                  <Field label="LOINC system"><Input type="url" value={metric.loincSystem} onChange={(event) => updateMetric(index, { loincSystem: event.target.value })} required /></Field>
                  <Field label="LOINC version"><Input value={metric.loincVersion} onChange={(event) => updateMetric(index, { loincVersion: event.target.value })} required /></Field>
                  <Field label="LOINC code"><Input value={metric.loincCode} onChange={(event) => updateMetric(index, { loincCode: event.target.value })} required /></Field>
                  <Field label="Display"><Input value={metric.display} onChange={(event) => updateMetric(index, { display: event.target.value })} required /></Field>
                  <Field label="Unit code"><Input value={metric.unitCode} onChange={(event) => updateMetric(index, { unitCode: event.target.value })} required /></Field>
                </div>
                {metrics.length > 1 ? <Button size="sm" variant="ghost" onClick={() => setMetrics((prev) => prev.filter((_, i) => i !== index))}>Remove metric</Button> : null}
              </div>
            ))}
            <div className="mv-row">
              <Button variant="secondary" onClick={() => setMetrics((prev) => [...prev, { nativeCode: "", loincSystem: "http://loinc.org", loincVersion: "", loincCode: "", display: "", unitCode: "" }])}>Add metric</Button>
              <Button type="submit" disabled={action.busy !== null || !serial || !manufacturer || !model}>{action.busy === "register" ? "Registering…" : "Register device"}</Button>
            </div>
          </form>
        </Card>
      ) : null}
      <Card title="Registered devices">
        {devices.loading ? <LoadingState /> : devices.error ? <ErrorState message={devices.error} onRetry={devices.reload} /> : !devices.data?.devices.length ? <EmptyState title="No devices" description={admin ? "Register a device to make it available for assignment." : "A facility administrator must register a device."} /> : (
          <div className="mv-stack">
            {devices.data.devices.map((device) => (
              <div key={device.id} className="mv-note">
                <div className="mv-spread"><strong>{device.manufacturer} {device.model}</strong><Badge tone={device.activeAssignment ? "info" : device.status === "active" ? "success" : "neutral"}>{device.activeAssignment ? "assigned" : device.status}</Badge></div>
                <div className="mv-small mv-muted">Serial {device.serial}{device.site ? ` · ${device.site}` : ""}{device.firmware ? ` · firmware ${device.firmware}` : ""}</div>
                <div className="mv-small mv-muted">Last seen {formatDateTime(device.lastSeenAt)}</div>
                {device.activeAssignment ? <div className="mv-small">Assigned to patient <span className="mv-id">{device.activeAssignment.patient_id}</span></div> : null}
                {clinical && !device.activeAssignment ? <AssignForm deviceId={device.id} onDone={devices.reload} /> : null}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function AssignForm({ deviceId, onDone }: { deviceId: string; onDone: () => void }) {
  const [patientId, setPatientId] = useState("");
  const [encounterId, setEncounterId] = useState("");
  const action = useAction();
  async function assign(event: FormEvent) {
    event.preventDefault();
    await action.run("assign", async () => {
      await api(`/devices/${deviceId}/assign`, { method: "POST", body: { patientId, encounterId } });
      onDone();
      return "Device assigned.";
    });
  }
  return (
    <details style={{ marginTop: 8 }}>
      <summary>Assign to a patient</summary>
      <form className="mv-stack" onSubmit={assign}>
        {action.error ? <ErrorState message={action.error} /> : null}
        <PatientPicker value={patientId} onChange={(value) => { setPatientId(value); setEncounterId(""); }} />
        <EncounterPicker value={encounterId} onChange={setEncounterId} patientId={patientId || undefined} />
        <Button size="sm" type="submit" disabled={action.busy !== null || !patientId || !encounterId}>{action.busy === "assign" ? "Assigning…" : "Assign device"}</Button>
      </form>
    </details>
  );
}

function Alerts({ clinical }: { clinical: boolean }) {
  const alerts = useQuery<{ alerts: Alert[] }>("/device-alerts");
  const action = useAction();
  const [notes, setNotes] = useState<Record<string, string>>({});
  async function acknowledge(alert: Alert) {
    await action.run(alert.id, async () => {
      await api(`/device-alerts/${alert.id}/acknowledge`, { method: "POST", body: { note: notes[alert.id] ?? "" } });
      alerts.reload();
      return "Alert acknowledged.";
    });
  }
  if (alerts.loading) return <LoadingState />;
  if (alerts.error) return <ErrorState message={alerts.error} onRetry={alerts.reload} />;
  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Active device alerts">
        {!alerts.data?.alerts.length ? <EmptyState title="No active alerts" description="Quality alerts appear here when a device reports questionable or invalid data." /> : (
          <Table head={["Patient", "Device", "Reading", "Message", "Detected", ""]} caption="Active device alerts">
            {alerts.data.alerts.map((alert) => (
              <tr key={alert.id}>
                <td>{alert.givenName} {alert.familyName}<div className="mv-small mv-muted mv-id">{alert.publicId}</div></td>
                <td>{alert.manufacturer} {alert.model}<div className="mv-small mv-muted">{alert.serial}</div></td>
                <td>{alert.valueNum} {alert.unitCode}<div className="mv-small mv-muted">{alert.nativeCode}</div></td>
                <td>{alert.message}</td>
                <td className="mv-small">{formatDateTime(alert.createdAt)}<div className="mv-muted">measured {formatDateTime(alert.measuredAt)}</div></td>
                <td>{clinical ? <div className="mv-stack" style={{ gap: 4 }}><Input aria-label={`Acknowledgement note for ${alert.id}`} placeholder="Note (optional)" value={notes[alert.id] ?? ""} onChange={(event) => setNotes((prev) => ({ ...prev, [alert.id]: event.target.value }))} /><Button size="sm" variant="secondary" onClick={() => void acknowledge(alert)} disabled={action.busy !== null}>Acknowledge</Button></div> : null}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
