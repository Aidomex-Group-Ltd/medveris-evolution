import { useMemo, useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs } from "@medveris/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDate, formatDateTime, formatMoney } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

interface CatalogItem {
  id: string; itemCode: string; name: string; genericName: string | null; brandName: string | null; strength: string | null;
  form: string | null; baseUnit: string; barcode: string | null; currency: string; sellingPrice: number; taxRate: number;
  prescriptionOnly: boolean; lotTracked: boolean; expiryTracked: boolean; availableQuantity: number;
}
interface Location { id: string; name: string; locationType: string; status: string }
interface PatientRow { id: string; publicId: string; givenName: string; familyName: string; dateOfBirth: string | null; sex: string; localMrn: string | null }
interface PrescriptionItem { id: string; itemId: string; name: string; doseText: string; route: string; frequency: string; quantity: number; repeatsAllowed: number; repeatsUsed: number; dispensedQuantity: number; directions: string | null; prescriptionOnly: boolean }
interface Prescription {
  id: string; reference: string; status: string; issuedOn: string; expiresOn: string | null; notes: string | null; version: number;
  createdAt: string;
  patientId: string; publicId: string; givenName: string; familyName: string; prescriberName: string; items: PrescriptionItem[] | null;
}
interface SaleRow {
  id: string; saleNumber: string; status: string; currency: string; subtotal: number; discount: number; tax: number; total: number;
  paymentMethod: string; createdAt: string; voidedAt: string | null; voidReason: string | null;
  publicId: string | null; givenName: string | null; familyName: string | null; cashierName: string; locationName: string; lineCount: number;
}
interface ReportData {
  summary: Array<{ day: string; sales: number; revenue: number; tax: number; discount: number }>;
  items: Array<{ itemCode: string; name: string; quantity: number; revenue: number; cost: number; margin: number }>;
}

/** Mirrors the server-side POS role gates in apps/api/src/routes/pharmacy-pos.ts. */
export const PHARMACY_POS_ROLES = ["pharmacist", "finance", "facility_admin", "owner"] as const;
const PRESCRIBER_ROLES = ["clinician", "specialist_clinician", "facility_admin", "owner"];
const VOID_ROLES = ["pharmacist", "facility_admin", "owner"];
const PAYMENT_METHODS = [
  { value: "cash", label: "Cash", referenceRequired: false },
  { value: "mobile-money", label: "Mobile money", referenceRequired: true },
  { value: "bank-transfer", label: "Bank transfer", referenceRequired: true },
  { value: "card", label: "Card", referenceRequired: true },
  { value: "manual", label: "Recorded offline", referenceRequired: false },
];

type Cart = Record<string, { quantity: string; discount: string }>;

function num(value: string): number {
  return Number(value) >= 0 && value !== "" ? Number(value) : 0;
}

export function PharmacyPosPage() {
  const { me } = useAuth();
  const roles = me?.activeTenant?.roles ?? [];
  const canSell = roles.some((role) => (PHARMACY_POS_ROLES as readonly string[]).includes(role));
  const canPrescribe = roles.some((role) => PRESCRIBER_ROLES.includes(role));
  const tabOptions = [
    { value: "checkout", label: "Checkout" },
    { value: "prescriptions", label: "Prescriptions" },
    { value: "sales", label: "Sales" },
    { value: "report", label: "Reports" },
  ].filter((tab) => (tab.value === "checkout" || tab.value === "sales" || tab.value === "report") ? canSell : canPrescribe);
  const [tab, setTab] = useState<"checkout" | "prescriptions" | "sales" | "report">(canSell ? "checkout" : "prescriptions");

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Pharmacy"
        title="Pharmacy point of sale"
        description="Prescriptions, retail checkout and daily sales for this workspace. Sales deduct FEFO stock exactly once, prescription products require a valid prescription, and expired lots are never sold."
      />
      {tabOptions.length ? (
        <Tabs label="Point-of-sale sections" value={tab} onChange={setTab} options={tabOptions as never} />
      ) : null}
      {canSell && tab === "checkout" ? <Checkout /> : null}
      {tab === "prescriptions" && (canPrescribe || canSell) ? <Prescriptions canSell={canSell} canPrescribe={canPrescribe} /> : null}
      {canSell && tab === "sales" ? <Sales /> : null}
      {canSell && tab === "report" ? <Reports /> : null}
    </div>
  );
}

// ---------------------------------------------------------------- checkout

function Checkout() {
  const locations = useQuery<{ locations: Location[] }>("/inventory/locations");
  const activeLocations = locations.data?.locations.filter((location) => location.status === "active") ?? [];
  const [locationId, setLocationId] = useState("");
  const [cart, setCart] = useState<Cart>({});
  const [patientQuery, setPatientQuery] = useState("");
  const [patientId, setPatientId] = useState("");
  const [prescriptionId, setPrescriptionId] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [paymentReference, setPaymentReference] = useState("");
  const [saleDiscountValue, setSaleDiscount] = useState("0");
  const [receipt, setReceipt] = useState<{ saleNumber: string; total: number; currency: string; lines: number } | null>(null);
  const action = useAction();
  const submissionKey = useMemo(() => crypto.randomUUID(), [receipt]);

  const catalog = useQuery<{ items: CatalogItem[] }>(locationId ? `/pharmacy/pos/catalog?locationId=${locationId}` : null);
  const patients = useQuery<{ patients: PatientRow[] }>(patientQuery.trim().length >= 2 ? `/pharmacy/pos/patients?q=${encodeURIComponent(patientQuery.trim())}` : null);

  const items = catalog.data?.items ?? [];
  const chosen = items.filter((item) => cart[item.id] !== undefined);
  const rxInCart = chosen.some((item) => item.prescriptionOnly);
  const prescriptions = useQuery<{ prescriptions: Prescription[] }>(
    locationId && rxInCart ? `/pharmacy/prescriptions?status=issued&patientId=${patientId}` : null,
    { enabled: locationId !== "" && rxInCart },
  );

  const totals = useMemo(() => {
    let subtotal = 0;
    let tax = 0;
    for (const item of chosen) {
      const line = cart[item.id]!;
      const base = item.sellingPrice * num(line.quantity) - num(line.discount);
      subtotal += Math.max(base, 0);
      tax += Math.max(base, 0) * (item.taxRate / 100);
    }
    const saleDiscount = Math.max(num(saleDiscountValue), 0);
    return { subtotal, tax, discount: saleDiscount, total: Math.max(subtotal + tax - saleDiscount, 0) };
  }, [cart, chosen, saleDiscountValue]);

  const currency = chosen[0]?.currency ?? "UGX";
  const referenceRequired = PAYMENT_METHODS.find((entry) => entry.value === paymentMethod)?.referenceRequired ?? false;

  const sellable = chosen.some((item) => num(cart[item.id]!.quantity) > 0);
  const disabled = action.busy !== null || !locationId || !chosen.length || !sellable || (rxInCart && !prescriptionId) || (referenceRequired && paymentReference.trim() === "");

  async function sell(event: FormEvent) {
    event.preventDefault();
    if (!locationId || !chosen.length) return;
    if (rxInCart && !prescriptionId) return;
    if (referenceRequired && paymentReference.trim() === "") return;
    setReceipt(null);
    if (await action.run("sell", async () => {
      const result = await api<{ sale: { saleNumber: string; total: number; subtotal: number; tax: number; discount: number } }>("/pharmacy/sales", {
        method: "POST",
        headers: { "idempotency-key": submissionKey },
        body: {
          locationId,
          patientId: patientId || undefined,
          prescriptionId: prescriptionId || undefined,
          currency,
          discount: num(saleDiscountValue),
          paymentMethod,
          paymentReference: paymentReference || undefined,
          lines: chosen.map((item) => ({ itemId: item.id, quantity: num(cart[item.id]!.quantity), discount: num(cart[item.id]!.discount) })),
        },
      });
      const summary = { saleNumber: result.sale.saleNumber, total: result.sale.total, currency, lines: chosen.length };
      setCart({});
      setPaymentReference("");
      setPrescriptionId("");
      setSaleDiscount("0");
      setReceipt(summary);
      return undefined;
    })) catalog.reload();
  }

  if (locations.loading && !locations.data) return <LoadingState />;
  if (locations.error) return <ErrorState message={locations.error} onRetry={locations.reload} />;

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {receipt ? (
        <Notice tone="success" title={`Receipt ${receipt.saleNumber}`}>
          Sale completed. {receipt.lines} line(s), total {formatMoney(receipt.total, receipt.currency)}. Stock was deducted batch by batch if more than one lot was needed.
        </Notice>
      ) : null}
      <div className="mv-grid mv-grid--2">
        <Card title="Choosing counter" description="Sales deduct stock from the selected location's own balances.">
          <div className="mv-form-grid">
            <Field label="Selling location" htmlFor="pos-location">
              <Select id="pos-location" value={locationId} onChange={(event) => { setLocationId(event.target.value); setCart({}); setPrescriptionId(""); }}>
                <option value="">Choose a counter</option>
                {activeLocations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
              </Select>
            </Field>
          </div>
        </Card>
        <Card title="Patient (optional)" description="Prescription sales must record the patient.">
          <div className="mv-form-grid">
            <Field label="Find patient" htmlFor="pos-patient" hint="At least 2 characters: name, record number or public id.">
              <Input id="pos-patient" value={patientQuery} onChange={(event) => { setPatientQuery(event.target.value); if (patientId) setPatientId(""); }} />
            </Field>
          </div>
          {patientQuery.trim().length >= 2 && patients.loading ? <LoadingState /> : null}
          {patientQuery.trim().length >= 2 && patients.data?.patients.length ? (
            <Table head={["Patient", "Record", "Born"]} caption="Matching patients">
              {patients.data.patients.map((patient) => (
                <tr key={patient.id}>
                  <td>{patient.givenName} {patient.familyName}</td>
                  <td className="mv-small mv-muted">{patient.localMrn ?? patient.publicId}</td>
                  <td className="mv-small">{formatDate(patient.dateOfBirth)}</td>
                  <td><Button size="sm" variant={patient.id === patientId ? "secondary" : "ghost"} onClick={() => { setPatientId(patient.id); setPatientQuery(`${patient.givenName} ${patient.familyName}`) }}>{patient.id === patientId ? "Selected" : "Select"}</Button></td>
                </tr>
              ))}
            </Table>
          ) : patientQuery.trim().length >= 2 ? <EmptyState title="No patient found" description="Check the spelling, register the patient, or sell without recording a patient." /> : null}
        </Card>
      </div>

      {!locationId ? <EmptyState title="Choose a counter" description="Select the selling location above to see what is in stock." /> : catalog.loading && !catalog.data ? <LoadingState /> : catalog.error && !catalog.data ? <ErrorState message={catalog.error} onRetry={catalog.reload} /> : (
        <Card title="Catalogue" description="Available quantity excludes reserved, quarantined and expired lots. Only lots inside their expiry date are shown.">
          <form className="mv-stack" onSubmit={sell}>
            {!items.length ? <EmptyState title="Nothing in stock here" description="Receive stock for this location first, then come back to sell." /> : (
              <Table head={["Product", "Price", "Available", "Qty", "Discount", "Rx", ""]} caption="Retail catalogue">
                {items.map((item) => {
                  const line = cart[item.id] ?? { quantity: "", discount: "0" };
                  const setLine = (patch: Partial<typeof line>) => setCart({ ...cart, [item.id]: { ...line, ...patch } });
                  return (
                    <tr key={item.id}>
                      <td>
                        <strong>{item.name}</strong>
                        <div className="mv-small mv-muted">
                          {item.genericName ? `${item.genericName} · ` : ""}{item.form ?? ""}{item.strength ? ` ${item.strength}` : ""} · <span className="mv-id">{item.itemCode}</span>
                        </div>
                      </td>
                      <td>{formatMoney(item.sellingPrice, item.currency)}{item.taxRate ? <div className="mv-small mv-muted">+{item.taxRate}% tax</div> : null}</td>
                      <td><Badge tone={item.availableQuantity > 0 ? "success" : "danger"}>{item.availableQuantity} {item.baseUnit}</Badge></td>
                      <td><Input aria-label={`Quantity of ${item.name}`} type="number" min="0" step="any" value={line.quantity} onChange={(event) => setLine({ quantity: event.target.value })} style={{ minWidth: 90 }} /></td>
                      <td><Input aria-label={`Discount for ${item.name}`} type="number" min="0" step="any" value={line.discount} onChange={(event) => setLine({ discount: event.target.value })} style={{ minWidth: 90 }} /></td>
                      <td>{item.prescriptionOnly ? <Badge tone="warning">Rx only</Badge> : <span className="mv-small mv-muted">OTC</span>}</td>
                      <td>{cart[item.id] !== undefined ? <Button size="sm" variant="ghost" onClick={() => { const next = { ...cart }; delete next[item.id]; setCart(next); }}>Remove</Button> : null}</td>
                    </tr>
                  );
                })}
              </Table>
            )}

            {chosen.length ? (
              <div className="mv-stack">
                {rxInCart ? (
                  prescriptions.loading ? <LoadingState label="Loading open prescriptions" /> : prescriptions.error ? <ErrorState message={prescriptions.error} onRetry={prescriptions.reload} /> : (
                    <Card title="Linked prescription" description="Prescription-only products need a valid, unexpired prescription for the selected patient.">
                      <Field label="Prescription" htmlFor="pos-prescription">
                        <Select id="pos-prescription" value={prescriptionId} onChange={(event) => {
                          setPrescriptionId(event.target.value);
                          const picked = prescriptions.data?.prescriptions.find((row) => row.id === event.target.value);
                          if (picked && !patientId) { setPatientId(picked.patientId); setPatientQuery(`${picked.givenName} ${picked.familyName}`); }
                        }}>
                          <option value="">Choose a prescription…</option>
                          {(prescriptions.data?.prescriptions ?? []).filter((row) => !patientId || row.patientId === patientId).map((row) => (
                            <option key={row.id} value={row.id}>{row.reference} · {row.givenName} {row.familyName} · issued {formatDate(row.issuedOn)}</option>
                          ))}
                        </Select>
                      </Field>
                      {!patientId ? <span className="mv-small mv-muted">Pick the patient first to limit prescriptions to them.</span> : null}
                    </Card>
                  )
                ) : null}
                <Card title="Payment and totals">
                  <div className="mv-form-grid">
                    <Field label="Payment method" htmlFor="pos-payment">
                      <Select id="pos-payment" value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}>
                        {PAYMENT_METHODS.map((method) => <option key={method.value} value={method.value}>{method.label}</option>)}
                      </Select>
                    </Field>
                    <Field label="Payment reference" htmlFor="pos-reference" hint={referenceRequired ? "Required for this payment method." : "Optional for this payment method."}>
                      <Input id="pos-reference" value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} />
                    </Field>
                    <Field label="Discount on the whole sale" htmlFor="pos-discount">
                      <Input id="pos-discount" type="number" min="0" step="any" value={saleDiscountValue} onChange={(event) => setSaleDiscount(event.target.value)} />
                    </Field>
                  </div>
                  <dl className="mv-small" style={{ margin: 0 }}>
                    <div className="mv-spread"><dt>Subtotal</dt><dd style={{ margin: 0 }}>{formatMoney(totals.subtotal, currency)}</dd></div>
                    <div className="mv-spread"><dt>Tax</dt><dd style={{ margin: 0 }}>{formatMoney(totals.tax, currency)}</dd></div>
                    <div className="mv-spread"><dt>Discount</dt><dd style={{ margin: 0 }}>−{formatMoney(totals.discount, currency)}</dd></div>
                    <div className="mv-spread"><dt><strong>Total</strong></dt><dd style={{ margin: 0 }}><strong>{formatMoney(totals.total, currency)}</strong></dd></div>
                  </dl>
                  <Button type="submit" disabled={disabled}>{action.busy === "sell" ? "Completing sale…" : "Complete sale"}</Button>
                  {rxInCart && !prescriptionId ? <Notice tone="warning">A prescription-only product is in the cart. Link a valid prescription before completing the sale.</Notice> : null}
                </Card>
              </div>
            ) : null}
          </form>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- prescriptions

function Prescriptions({ canSell, canPrescribe }: { canSell: boolean; canPrescribe: boolean }) {
  const [patientQuery, setPatientQuery] = useState("");
  const patients = useQuery<{ patients: PatientRow[] }>(canPrescribe && patientQuery.trim().length >= 2 ? `/pharmacy/pos/patients?q=${encodeURIComponent(patientQuery.trim())}` : null);
  const [patientId, setPatientId] = useState("");
  const [statusFilter, setStatusFilter] = useState("issued");
  const list = useQuery<{ prescriptions: Prescription[] }>(`/pharmacy/prescriptions?status=${statusFilter}${patientId ? `&patientId=${patientId}` : ""}`);
  const action = useAction();

  async function cancel(row: Prescription) {
    const reason = window.prompt("Why is this prescription cancelled? (at least 5 characters)");
    if (!reason || reason.trim().length < 5) return;
    await action.run(`cancel-${row.id}`, async () => {
      await api(`/pharmacy/prescriptions/${row.id}/cancel`, { method: "POST", body: { expectedVersion: row.version, reason: reason.trim() } });
      list.reload();
      return `Prescription ${row.reference} cancelled.`;
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {canPrescribe ? <IssuePrescription patientId={patientId} setPatientId={setPatientId} patients={patients} onCreated={() => {
        setPatientQuery("");
        setPatientId("");
        list.reload();
      }} /> : null}
      <Card title="Prescriptions" description="Statuses follow issue, dispensing and cancellation. Dispensed lines show how much must still be supplied.">
        <div className="mv-form-grid">
          <Field label="Status" htmlFor="prescription-status">
            <Select id="prescription-status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="issued">Issued</option>
              <option value="partially-dispensed">Partially dispensed</option>
              <option value="dispensed">Dispensed</option>
              <option value="cancelled">Cancelled</option>
              <option value="all">All statuses</option>
            </Select>
          </Field>
          {patientId ? <span className="mv-small">Filtered to one patient. <Button size="sm" variant="ghost" onClick={() => { setPatientId(""); setPatientQuery(""); }}>Clear</Button></span> : null}
        </div>
        {list.loading ? <LoadingState /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : !list.data?.prescriptions.length ? <EmptyState title="No prescriptions" description={canPrescribe ? "Issue a prescription from a consultation, or below for a walk-in patient." : "Issued prescriptions will appear here for dispensing."} /> : (
          <div className="mv-stack">
            {list.data.prescriptions.map((row) => (
              <div key={row.id} className={`mv-note mv-note--${row.status}`}>
                <div className="mv-spread">
                  <div>
                    <strong>{row.reference}</strong> · {row.givenName} {row.familyName} <span className="mv-small mv-muted">{row.publicId}</span>
                    <div className="mv-small mv-muted">Issued {formatDate(row.issuedOn)}{row.expiresOn ? ` · expires ${formatDate(row.expiresOn)}` : ""} · by {row.prescriberName} · {formatDateTime(row.createdAt)}</div>
                  </div>
                  <div className="mv-row">
                    <Badge tone={row.status === "issued" ? "info" : row.status === "dispensed" ? "success" : row.status === "cancelled" ? "danger" : "warning"}>{row.status}</Badge>
                    {row.status === "issued" || row.status === "partially-dispensed" ? (canPrescribe || canSell ? <Button size="sm" variant="ghost" disabled={action.busy !== null} onClick={() => void cancel(row)}>Cancel</Button> : null) : null}
                  </div>
                </div>
                {row.items?.length ? (
                  <ul className="mv-small" style={{ margin: 0, paddingLeft: 18 }}>
                    {row.items.map((item) => (
                      <li key={item.id}>
                        {item.name} — {item.doseText}, {item.route}, {item.frequency}. Requested {item.quantity}{item.repeatsAllowed ? ` ×${item.repeatsAllowed + 1} with repeats` : ""}; dispensed {item.dispensedQuantity}.
                        {item.directions ? ` ${item.directions}` : ""}
                        {item.prescriptionOnly ? "" : " (OTC)"}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function IssuePrescription({
  patientId, setPatientId, patients, onCreated,
}: {
  patientId: string; setPatientId: (value: string) => void;
  patients: ReturnType<typeof useQuery<{ patients: PatientRow[] }>>;
  onCreated: () => void;
}) {
  const [patientQuery, setPatientQuery] = useState("");
  const catalogue = useQuery<{ items: Array<{ id: string; itemCode: string; name: string; baseUnit: string; prescriptionOnly: boolean; strength: string | null; form: string | null }> }>("/inventory/items?status=active");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [items, setItems] = useState<Array<{ itemId: string; quantity: string; doseText: string; route: string; frequency: string; repeatsAllowed: string; directions: string }>>([]);
  const action = useAction();

  function setItem(index: number, patch: Partial<(typeof items)[number]>) {
    setItems(items.map((item, position) => (position === index ? { ...item, ...patch } : item)));
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!patientId || !items.length) return;
    await action.run("issue", async () => {
      await api("/pharmacy/prescriptions", {
        method: "POST",
        body: {
          patientId,
          reference: `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`,
          expiresOn: expiresOn || null,
          notes: notes || "",
          items: items.map((item) => ({
            itemId: item.itemId, quantity: num(item.quantity), doseText: item.doseText, route: item.route,
            frequency: item.frequency, repeatsAllowed: num(item.repeatsAllowed), directions: item.directions || "",
            prescriptionOnly: Boolean(catalogue.data?.items.find((entry) => entry.id === item.itemId)?.prescriptionOnly ?? true),
          })),
        },
      });
      setItems([]); setNotes(""); setExpiresOn(""); setReference("");
      onCreated();
      return "Prescription issued.";
    });
  }

  return (
    <Card title="Issue a prescription" description="Only a clinician, the owner or an administrator may issue. Products must belong to this workspace's catalogue.">
      <form className="mv-stack" onSubmit={create}>
        <div className="mv-form-grid">
          <Field label="Find patient" htmlFor="rx-patient" hint="Name, record number or public id (2+ characters).">
            <Input id="rx-patient" value={patientQuery} onChange={(event) => { setPatientQuery(event.target.value); setPatientId(""); }} />
          </Field>
          <Field label="Reference" htmlFor="rx-reference" hint="Left empty, a unique reference is generated.">
            <Input id="rx-reference" value={reference} onChange={(event) => setReference(event.target.value)} maxLength={80} />
          </Field>
          <Field label="Expires on" htmlFor="rx-expires" hint="Blank means the prescription is valid until dispensed.">
            <Input id="rx-expires" type="date" value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} />
          </Field>
        </div>
        {patientQuery.trim().length >= 2 ? (patients.loading ? <LoadingState /> : patients.data?.patients.length ? (
          <Table head={["Patient", "Record", "Select"]} caption="Matching patients">
            {patients.data.patients.map((patient) => (
              <tr key={patient.id}>
                <td>{patient.givenName} {patient.familyName}</td>
                <td className="mv-small mv-muted">{patient.localMrn ?? patient.publicId}</td>
                <td><Button size="sm" variant={patient.id === patientId ? "secondary" : "ghost"} onClick={() => setPatientId(patient.id)}>{patient.id === patientId ? "Selected" : "Select"}</Button></td>
              </tr>
            ))}
          </Table>
        ) : <EmptyState title="No patient found" description="Register the patient first, or search another spelling." />) : null}

        {items.map((item, index) => {
          const product = catalogue.data?.items.find((entry) => entry.id === item.itemId);
          return (
            <div className="mv-form-grid" key={index}>
              <Field label="Product" htmlFor={`rx-item-${index}`}>
                <Select id={`rx-item-${index}`} value={item.itemId} onChange={(event) => setItem(index, { itemId: event.target.value })} required>
                  <option value="">Choose a product…</option>
                  {(catalogue.data?.items ?? []).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{entry.strength ? ` ${entry.strength}` : ""}{entry.prescriptionOnly ? " (Rx)" : ""}</option>)}
                </Select>
              </Field>
              <Field label="Dose" htmlFor={`rx-dose-${index}`}><Input id={`rx-dose-${index}`} value={item.doseText} onChange={(event) => setItem(index, { doseText: event.target.value })} required placeholder="1 tablet" /></Field>
              <Field label="Route" htmlFor={`rx-route-${index}`}><Input id={`rx-route-${index}`} value={item.route} onChange={(event) => setItem(index, { route: event.target.value })} required placeholder="oral" /></Field>
              <Field label="Frequency" htmlFor={`rx-freq-${index}`}><Input id={`rx-freq-${index}`} value={item.frequency} onChange={(event) => setItem(index, { frequency: event.target.value })} required placeholder="twice daily" /></Field>
              <Field label="Quantity" htmlFor={`rx-qty-${index}`} hint={product ? `per ${product.baseUnit}? leave as dispensed unit` : undefined}><Input id={`rx-qty-${index}`} type="number" min="0" step="any" value={item.quantity} onChange={(event) => setItem(index, { quantity: event.target.value })} required /></Field>
              <Field label="Repeats" htmlFor={`rx-repeats-${index}`}><Input id={`rx-repeats-${index}`} type="number" min="0" max="24" step="1" value={item.repeatsAllowed} onChange={(event) => setItem(index, { repeatsAllowed: event.target.value })} /></Field>
              <Field label="Directions" htmlFor={`rx-directions-${index}`}><Input id={`rx-directions-${index}`} value={item.directions} onChange={(event) => setItem(index, { directions: event.target.value })} /></Field>
              <div>{items.length > 1 ? <Button type="button" size="sm" variant="ghost" onClick={() => setItems(items.filter((_, position) => position !== index))}>Remove</Button> : null}</div>
            </div>
          );
        })}

        <div className="mv-row">
          <Button type="button" size="sm" variant="secondary" onClick={() => setItems([...items, { itemId: "", quantity: "1", doseText: "", route: "oral", frequency: "", repeatsAllowed: "0", directions: "" }])}>Add product</Button>
          <Button type="submit" disabled={action.busy !== null || !patientId || !items.length}>Issue prescription</Button>
        </div>
        <Field label="Notes for the dispenser" htmlFor="rx-notes"><Input id="rx-notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} /></Field>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------- sales

function Sales() {
  const [status, setStatus] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { me } = useAuth();
  const roles = me?.activeTenant?.roles ?? [];
  const canVoid = roles.some((role) => VOID_ROLES.includes(role));
  const query = new URLSearchParams({ status });
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  const sales = useQuery<{ sales: SaleRow[] }>(`/pharmacy/sales?${query.toString()}`);
  const action = useAction();

  async function voidSale(row: SaleRow) {
    const reason = window.prompt(`Why is sale ${row.saleNumber} voided? Stock is returned and the prescription is reopened. (at least 5 characters)`);
    if (!reason || reason.trim().length < 5) return;
    await action.run(`void-${row.id}`, async () => {
      await api(`/pharmacy/sales/${row.id}/void`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: { reason: reason.trim() } });
      sales.reload();
      return `Sale ${row.saleNumber} voided and stock returned.`;
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Sales" description="Every completed sale records who sold it, from which counter, and which stock batch was used. Voids return the stock and keep the original visible.">
        <div className="mv-form-grid">
          <Field label="Status" htmlFor="sale-status">
            <Select id="sale-status" value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="all">All</option>
              <option value="completed">Completed</option>
              <option value="voided">Voided</option>
            </Select>
          </Field>
          <Field label="From" htmlFor="sale-from"><Input id="sale-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></Field>
          <Field label="To" htmlFor="sale-to"><Input id="sale-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></Field>
        </div>
        {sales.loading ? <LoadingState /> : sales.error ? <ErrorState message={sales.error} onRetry={sales.reload} /> : !sales.data?.sales.length ? <EmptyState title="No sales yet" description="Completed checkouts appear here immediately." /> : (
          <Table head={["Sale", "Patient", "Lines", "Total", "Payment", "Cashier", "Counter", "Status"]} caption="Pharmacy sales">
            {sales.data.sales.map((row) => (
              <tr key={row.id}>
                <td><span className="mv-id">{row.saleNumber}</span><div className="mv-small mv-muted">{formatDateTime(row.createdAt)}</div></td>
                <td className="mv-small">{row.givenName ? `${row.givenName} ${row.familyName}` : "—"}</td>
                <td>{row.lineCount}</td>
                <td>{formatMoney(row.total, row.currency)}{row.discount ? <div className="mv-small mv-muted">discount −{formatMoney(row.discount, row.currency)}</div> : null}</td>
                <td className="mv-small">{row.paymentMethod}</td>
                <td className="mv-small">{row.cashierName}</td>
                <td className="mv-small">{row.locationName}</td>
                <td>
                  <Badge tone={row.status === "voided" ? "danger" : "success"}>{row.status === "voided" ? "voided" : "completed"}</Badge>
                  {canVoid && row.status === "completed" ? <Button size="sm" variant="ghost" disabled={action.busy !== null} onClick={() => void voidSale(row)}>Void</Button> : null}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- reports

function Reports() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const suffix = params.toString();
  const report = useQuery<ReportData>(`/pharmacy/reports/sales${suffix ? `?${suffix}` : ""}`);
  return (
    <div className="mv-stack">
      <Card title="Sales report" description="Completed sales only. Voids are excluded; the sales list keeps them visible.">
        <div className="mv-form-grid">
          <Field label="From" htmlFor="report-from"><Input id="report-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></Field>
          <Field label="To" htmlFor="report-to"><Input id="report-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></Field>
        </div>
        {report.loading ? <LoadingState /> : report.error ? <ErrorState message={report.error} onRetry={report.reload} /> : (
          <>
            <Table head={["Day", "Sales", "Revenue", "Tax", "Discount"]} caption="Daily summary">
              {(report.data?.summary ?? []).map((row) => (
                <tr key={row.day}><td>{row.day}</td><td>{row.sales}</td><td>{formatMoney(row.revenue, "UGX")}</td><td>{formatMoney(row.tax, "UGX")}</td><td>{formatMoney(row.discount, "UGX")}</td></tr>
              ))}
            </Table>
            <Table head={["Product", "Units sold", "Revenue", "Cost", "Margin"]} caption="Top products">
              {(report.data?.items ?? []).map((row) => (
                <tr key={row.itemCode}><td><strong>{row.name}</strong> <span className="mv-small mv-muted mv-id">{row.itemCode}</span></td><td>{row.quantity}</td><td>{formatMoney(row.revenue, "UGX")}</td><td>{formatMoney(row.cost, "UGX")}</td><td>{formatMoney(row.margin, "UGX")}</td></tr>
              ))}
            </Table>
            <div className="mv-row">
              <a className="mv-button mv-button--secondary mv-button--sm" href={`/api/v1/pharmacy/reports/sales?format=csv${suffix ? `&${suffix}` : ""}`}>Download CSV</a>
              {!(report.data?.summary ?? []).length && !(report.data?.items ?? []).length ? <span className="mv-small mv-muted">No completed sales in this range yet.</span> : null}
            </div>
          </>
        )}
      </Card>
      <Notice tone="info">Cost uses the batch unit cost recorded at receipt, so margin follows real purchasing history.</Notice>
    </div>
  );
}
