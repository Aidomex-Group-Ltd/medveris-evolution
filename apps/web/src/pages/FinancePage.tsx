import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDateTime, formatMoney } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { EncounterPicker, PatientPicker } from "../components/Pickers";
import { CATALOGUE_CATEGORIES } from "@medveris/domain";

interface Service { id: string; code: string; name: string; category: string; price: string | number; currency: string; active: boolean }
interface Invoice { id: string; number: string; patientId: string; currency: string; status: string; notes: string | null; createdAt: string; publicId: string; givenName: string; familyName: string; total: string | number; paid: string | number }
interface Summary { billed: string | number; collected: string | number; openInvoices: number }

interface DraftLine { serviceId: string; description: string; quantity: string; unitPrice: string }

export function FinancePage() {
  const [tab, setTab] = useState<"overview" | "invoices" | "catalogue">("overview");
  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Finance"
        title="Billing and payments"
        description="Bills, cash and mobile money payments, reversals and claims are audited. Take payments at the point of sale."
        actions={<div className="mv-row"><Link className="mv-button mv-button--primary mv-button--md" to="/pos">Point of sale</Link><Link className="mv-button mv-button--secondary mv-button--md" to="/price-list">Price list</Link></div>}
      />
      <Tabs label="Finance sections" value={tab} onChange={setTab} options={[{ value: "overview", label: "Overview" }, { value: "invoices", label: "Invoices" }, { value: "catalogue", label: "Catalogue" }]} />
      {tab === "overview" ? <Overview /> : null}
      {tab === "invoices" ? <Invoices /> : null}
      {tab === "catalogue" ? <Catalogue /> : null}
    </div>
  );
}

function Overview() {
  const summary = useQuery<{ summary: Summary }>("/finance/summary");
  const invoices = useQuery<{ invoices: Invoice[] }>("/invoices");
  if (summary.loading) return <LoadingState label="Loading finance summary" variant="page" />;
  if (summary.error) return <ErrorState message={summary.error} onRetry={summary.reload} />;
  const data = summary.data?.summary;
  const outstanding = Number(data?.billed ?? 0) - Number(data?.collected ?? 0);
  return (
    <div className="mv-stack">
      <div className="mv-grid mv-grid--3">
        <Card title="Billed" description="Non-void invoices"><p className="mv-metric">{formatMoney(data?.billed)}</p></Card>
        <Card title="Collected" description="Excludes reversed payments"><p className="mv-metric">{formatMoney(data?.collected)}</p></Card>
        <Card title="Outstanding" description={`${data?.openInvoices ?? 0} open or part-paid invoices`}><p className="mv-metric">{formatMoney(outstanding)}</p></Card>
      </div>
      <Card title="Recent invoices">
        {invoices.loading ? <LoadingState /> : invoices.error ? <ErrorState message={invoices.error} onRetry={invoices.reload} /> : !invoices.data?.invoices.length ? <EmptyState title="No invoices" description="Create an invoice from the Invoices tab." /> : (
          <Table head={["Invoice", "Patient", "Total", "Paid", "Status"]} caption="Recent invoices">
            {invoices.data.invoices.slice(0, 10).map((invoice) => (
              <tr key={invoice.id}>
                <td><Link to={`/finance/invoices/${invoice.id}`}>{invoice.number}</Link><div className="mv-small mv-muted">{formatDateTime(invoice.createdAt)}</div></td>
                <td>{invoice.givenName} {invoice.familyName}</td>
                <td>{formatMoney(invoice.total, invoice.currency)}</td>
                <td>{formatMoney(invoice.paid, invoice.currency)}</td>
                <td><Badge tone={invoice.status === "paid" ? "success" : invoice.status === "void" ? "neutral" : invoice.status === "part-paid" ? "warning" : "info"}>{invoice.status}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function Invoices() {
  const [statusFilter, setStatusFilter] = useState("");
  const invoices = useQuery<{ invoices: Invoice[] }>(`/invoices${statusFilter ? `?status=${statusFilter}` : ""}`);
  const services = useQuery<{ services: Service[] }>("/service-catalog");
  const [showForm, setShowForm] = useState(false);
  const [patientId, setPatientId] = useState("");
  const [encounterId, setEncounterId] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ serviceId: "", description: "", quantity: "1", unitPrice: "" }]);
  const action = useAction();

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    const items = lines.filter((line) => line.description.trim()).map((line) => ({
      serviceId: line.serviceId || null,
      description: line.description.trim(),
      quantity: Number(line.quantity),
      unitPrice: line.unitPrice === "" ? undefined : Number(line.unitPrice),
    }));
    if (!items.length) {
      action.setError("Add at least one invoice line.");
      return;
    }
    await action.run("invoice", async () => {
      const result = await api<{ invoice: { id: string; number: string } }>("/invoices", {
        method: "POST",
        body: { patientId, encounterId: encounterId || null, items, notes },
      });
      setShowForm(false);
      setLines([{ serviceId: "", description: "", quantity: "1", unitPrice: "" }]);
      invoices.reload();
      return `Invoice ${result.invoice.number} created.`;
    });
  }

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card title="Invoices" actions={<div className="mv-row"><Select aria-label="Filter invoices by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All statuses</option><option value="open">Open</option><option value="part-paid">Part paid</option><option value="paid">Paid</option><option value="void">Void</option></Select><Button onClick={() => setShowForm((prev) => !prev)}>{showForm ? "Close form" : "New invoice"}</Button></div>}>
        {invoices.loading ? <LoadingState /> : invoices.error ? <ErrorState message={invoices.error} onRetry={invoices.reload} /> : !invoices.data?.invoices.length ? <EmptyState title="No invoices" description="Create an invoice for a linked patient." /> : (
          <Table head={["Invoice", "Patient", "Total", "Paid", "Status", ""]} caption="Invoices">
            {invoices.data.invoices.map((invoice) => (
              <tr key={invoice.id}>
                <td><strong>{invoice.number}</strong><div className="mv-small mv-muted">{formatDateTime(invoice.createdAt)}</div></td>
                <td>{invoice.givenName} {invoice.familyName}<div className="mv-small mv-muted mv-id">{invoice.publicId}</div></td>
                <td>{formatMoney(invoice.total, invoice.currency)}</td>
                <td>{formatMoney(invoice.paid, invoice.currency)}</td>
                <td><Badge tone={invoice.status === "paid" ? "success" : invoice.status === "void" ? "neutral" : invoice.status === "part-paid" ? "warning" : "info"}>{invoice.status}</Badge></td>
                <td><Link className="mv-button mv-button--secondary mv-button--sm" to={`/finance/invoices/${invoice.id}`}>Open</Link></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {showForm ? (
        <Card title="Create invoice" description="Catalogue lines use the configured price and currency. Custom lines require an explicit unit price in UGX.">
          <form className="mv-stack" onSubmit={create}>
            <div className="mv-form-grid">
              <PatientPicker value={patientId} onChange={(value) => { setPatientId(value); setEncounterId(""); }} />
              <EncounterPicker value={encounterId} onChange={setEncounterId} patientId={patientId || undefined} label="Encounter (optional)" />
            </div>
            {lines.map((line, index) => (
              <div key={index} className="mv-note">
                <div className="mv-form-grid">
                  <Field label="Catalogue service">
                    <Select value={line.serviceId} onChange={(event) => {
                      const service = services.data?.services.find((row) => row.id === event.target.value);
                      updateLine(index, { serviceId: event.target.value, description: service?.name ?? line.description, unitPrice: service ? String(service.price) : line.unitPrice });
                    }}>
                      <option value="">Custom line</option>
                      {services.data?.services.map((service) => <option key={service.id} value={service.id}>{service.name} — {formatMoney(service.price, service.currency)}</option>)}
                    </Select>
                  </Field>
                  <Field label="Description"><Input value={line.description} onChange={(event) => updateLine(index, { description: event.target.value })} required /></Field>
                  <Field label="Quantity"><Input type="number" min={0.01} step="any" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} required /></Field>
                  <Field label="Unit price"><Input type="number" min={0} step="any" value={line.unitPrice} onChange={(event) => updateLine(index, { unitPrice: event.target.value })} disabled={Boolean(line.serviceId && line.unitPrice)} /></Field>
                </div>
                {lines.length > 1 ? <Button size="sm" variant="ghost" onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}>Remove line</Button> : null}
              </div>
            ))}
            <div className="mv-row">
              <Button variant="secondary" onClick={() => setLines((prev) => [...prev, { serviceId: "", description: "", quantity: "1", unitPrice: "" }])}>Add line</Button>
              <Button type="submit" disabled={action.busy !== null || !patientId}>{action.busy === "invoice" ? "Creating…" : "Create invoice"}</Button>
            </div>
            <Field label="Notes" htmlFor="invoice-notes"><Textarea id="invoice-notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} /></Field>
          </form>
        </Card>
      ) : null}
    </div>
  );
}

function Catalogue() {
  const services = useQuery<{ services: Service[] }>("/service-catalog");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("consultation");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("UGX");
  const action = useAction();
  async function create(event: FormEvent) {
    event.preventDefault();
    await action.run("service", async () => {
      await api("/service-catalog", { method: "POST", body: { code, name, category, price: Number(price), currency } });
      setCode("");
      setName("");
      setPrice("");
      services.reload();
      return "Catalogue service created.";
    });
  }
  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Notice tone="info">Procedures, supplies, pharmacy items, departments and price changes are managed on the <Link to="/price-list">price list</Link>.</Notice>
      <Card title="Service catalogue">
        {services.loading ? <LoadingState /> : services.error ? <ErrorState message={services.error} onRetry={services.reload} /> : !services.data?.services.length ? <EmptyState title="No services" description="Add a billable service below." /> : (
          <Table head={["Code", "Service", "Category", "Price", "Status"]} caption="Service catalogue">
            {services.data.services.map((service) => <tr key={service.id}><td className="mv-id">{service.code}</td><td>{service.name}</td><td>{service.category}</td><td>{formatMoney(service.price, service.currency)}</td><td><Badge tone={service.active ? "success" : "neutral"}>{service.active ? "active" : "inactive"}</Badge></td></tr>)}
          </Table>
        )}
      </Card>
      <Card title="Add a service">
        <form className="mv-stack" onSubmit={create}>
          <div className="mv-form-grid">
            <Field label="Code" htmlFor="service-code"><Input id="service-code" value={code} onChange={(event) => setCode(event.target.value)} required maxLength={50} /></Field>
            <Field label="Name" htmlFor="service-name"><Input id="service-name" value={name} onChange={(event) => setName(event.target.value)} required minLength={2} /></Field>
            <Field label="Category"><Select value={category} onChange={(event) => setCategory(event.target.value)}>{CATALOGUE_CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
            <Field label="Price"><Input type="number" min={0} step="any" value={price} onChange={(event) => setPrice(event.target.value)} required /></Field>
            <Field label="Currency" htmlFor="service-currency"><Input id="service-currency" value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} minLength={3} maxLength={3} required /></Field>
          </div>
          <Button type="submit" disabled={action.busy !== null || !code || !name || !price}>{action.busy === "service" ? "Adding…" : "Add service"}</Button>
        </form>
      </Card>
    </div>
  );
}
