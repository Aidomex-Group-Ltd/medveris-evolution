import { useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { departmentForCategory, WORKFLOW_DEPARTMENTS } from "@medveris/domain";
import { Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, Select, Textarea } from "@medveris/ui";
import { api, errorMessage } from "../lib/api";
import { formatDateTime, formatMoney } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";
import { departmentLabel } from "../lib/workspace";
import type { CatalogueItem, Recommendation, RecommendationStatus, VisitWorkflow, WorkflowDepartment } from "../lib/types";
import { BillingBadge, PriorityBadge, RequestStatusBadge } from "./WorkflowBadges";

interface HistoryEvent { id: string; event: string; fromStatus: string | null; toStatus: string | null; note: string | null; occurredAt: string; actorName: string | null; changes: Record<string, unknown> }

/** Next steps a department can take from each status. */
const DEPARTMENT_ACTIONS: Partial<Record<RecommendationStatus, Array<{ status: RecommendationStatus; label: string; needsNote?: boolean }>>> = {
  requested: [{ status: "accepted", label: "Accept" }, { status: "in-progress", label: "Start" }, { status: "declined", label: "Decline", needsNote: true }],
  accepted: [{ status: "in-progress", label: "Start" }, { status: "completed", label: "Complete" }, { status: "declined", label: "Decline", needsNote: true }],
  "in-progress": [{ status: "completed", label: "Complete" }, { status: "declined", label: "Decline", needsNote: true }],
};

/**
 * A visit's recommendations, department progress and supplied items. Clinicians recommend work; departments
 * progress it; reception and cashiers follow status and billing. What each person sees follows their role.
 */
export function VisitWorkflowPanel({ encounterId, compact = false }: { encounterId: string; compact?: boolean }) {
  const workflow = useQuery<VisitWorkflow>(`/encounters/${encounterId}/workflow`);
  const catalogue = useQuery<{ services: CatalogueItem[] }>("/service-catalog?active=true");
  const action = useAction();
  const [showForm, setShowForm] = useState(false);
  const [showSupply, setShowSupply] = useState(false);

  if (workflow.loading && !workflow.data) return <LoadingState label="Loading requests" />;
  if (workflow.error) return <ErrorState message={workflow.error} onRetry={workflow.reload} />;
  if (!workflow.data) return null;
  const data = workflow.data;
  const canRequest = data.permissions.recommend || data.permissions.directRequestDepartments.length > 0;
  const open = data.recommendations.filter((row) => ["requested", "accepted", "in-progress"].includes(row.status));
  const activeSupplies = data.supplies.filter((supply) => !supply.voidedAt);

  return (
    <div className="mv-stack">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      <Card
        title={data.permissions.recommend ? "Recommendations and requests" : "Requests for this visit"}
        description={`${open.length} open · ${data.recommendations.length - open.length} closed. Every change is recorded with who made it and when.`}
        actions={canRequest && !showForm ? <Button size="sm" onClick={() => setShowForm(true)}>{data.permissions.recommend ? "Recommend a service" : "Add a request"}</Button> : null}
      >
        {showForm ? (
          <RecommendationForm
            encounterId={encounterId}
            departments={data.permissions.recommend ? [...WORKFLOW_DEPARTMENTS] : data.permissions.directRequestDepartments}
            consultation={data.permissions.recommend}
            catalogue={catalogue.data?.services ?? []}
            onCancel={() => setShowForm(false)}
            onSaved={(message) => { setShowForm(false); action.setMessage(message); workflow.reload(); }}
          />
        ) : null}
        {!data.recommendations.length ? (
          <EmptyState
            title="Nothing requested yet"
            description={canRequest ? "Requests for laboratory, imaging, theatre, pharmacy or procedures appear here and in the department's queue." : "When a clinician or department records a request, its progress appears here."}
          />
        ) : (
          <div className="mv-stack" style={{ marginTop: showForm ? 16 : 0 }}>
            {data.recommendations.map((row) => (
              <RecommendationRow key={row.id} row={row} compact={compact} onChanged={(message) => { action.setMessage(message); workflow.reload(); }} onError={action.setError} />
            ))}
          </div>
        )}
      </Card>

      {data.permissions.recordSupplies || activeSupplies.length ? (
        <Card
          title="Supplied items"
          description="Supplies and items given during the visit. Each is billed once."
          actions={data.permissions.recordSupplies && !showSupply ? <Button size="sm" variant="secondary" onClick={() => setShowSupply(true)}>Record supplied item</Button> : null}
        >
          {showSupply ? (
            <SupplyForm
              encounterId={encounterId}
              catalogue={catalogue.data?.services ?? []}
              requests={open}
              onCancel={() => setShowSupply(false)}
              onSaved={(message) => { setShowSupply(false); action.setMessage(message); workflow.reload(); }}
            />
          ) : null}
          {!data.supplies.length ? <EmptyState title="No supplied items" description="Record dressings, reagents, contrast or dispensed items used for this patient." /> : (
            <ul className="mv-stack" style={{ listStyle: "none", padding: 0, margin: showSupply ? "16px 0 0" : 0 }}>
              {data.supplies.map((supply) => (
                <li key={supply.id} className="mv-spread">
                  <div>
                    <strong style={supply.voidedAt ? { textDecoration: "line-through" } : undefined}>{supply.name}</strong> × {supply.quantity}
                    <div className="mv-small mv-muted">{supply.recordedByName} · {formatDateTime(supply.recordedAt)}{supply.voidedAt ? ` · voided: ${supply.voidReason}` : ""}{supply.note ? ` · ${supply.note}` : ""}</div>
                  </div>
                  <div className="mv-row">
                    {supply.unitPrice != null ? <span className="mv-small mv-money">{formatMoney(supply.unitPrice * supply.quantity, supply.currency ?? "UGX")}</span> : null}
                    {!supply.voidedAt ? <BillingBadge status={supply.billingStatus} /> : null}
                    {!supply.voidedAt && supply.billingStatus === "unbilled" && data.permissions.recordSupplies ? (
                      <Button size="sm" variant="ghost" disabled={action.busy !== null} onClick={() => {
                        const reason = window.prompt("Why is this supplied item being voided?");
                        if (!reason || reason.trim().length < 5) return;
                        void action.run(supply.id, async () => {
                          await api(`/supplies/${supply.id}/void`, { method: "POST", body: { reason: reason.trim() } });
                          workflow.reload();
                          return "Supplied item voided.";
                        });
                      }}>Void</Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {data.permissions.bill ? (
        <div className="mv-row mv-no-print">
          <Link className="mv-button mv-button--secondary mv-button--md" to={`/pos?encounter=${encounterId}`}>Bill this visit</Link>
        </div>
      ) : null}
    </div>
  );
}

function RecommendationRow({ row, compact, onChanged, onError }: { row: Recommendation; compact: boolean; onChanged: (message: string) => void; onError: (message: string) => void }) {
  const [history, setHistory] = useState<HistoryEvent[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [priority, setPriority] = useState(row.priority);
  const [instructions, setInstructions] = useState(row.instructions ?? "");

  async function call(fn: () => Promise<void>, message: string) {
    setBusy(true);
    try {
      await fn();
      onChanged(message);
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function transition(status: RecommendationStatus, label: string, needsNote?: boolean) {
    let note: string | null = null;
    if (needsNote || status === "cancelled") {
      note = window.prompt(status === "cancelled" ? "Why is this request being cancelled?" : "Why can the department not do this?");
      if (!note || note.trim().length < 3) return;
    } else if (status === "completed") {
      note = window.prompt("Completion note (optional)") ?? "";
    }
    void call(async () => {
      await api(`/recommendations/${row.id}/transitions`, { method: "POST", body: { status, expectedVersion: row.version, note: note?.trim() ?? "" } });
    }, `${row.description}: ${label.toLowerCase()}.`);
  }

  async function toggleHistory() {
    if (history) {
      setHistory(null);
      return;
    }
    try {
      const response = await api<{ events: HistoryEvent[] }>(`/recommendations/${row.id}`);
      setHistory(response.events);
    } catch (cause) {
      onError(errorMessage(cause));
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    void call(async () => {
      await api(`/recommendations/${row.id}`, { method: "PATCH", body: { expectedVersion: row.version, priority, instructions } });
      setEditing(false);
    }, "Request updated.");
  }

  return (
    <div className={`mv-queue-item${row.priority === "emergency" ? " mv-queue-item--emergency" : row.priority === "urgent" ? " mv-queue-item--urgent" : ""}`}>
      <div className="mv-spread">
        <div>
          <strong>{row.description}</strong>{row.quantity !== 1 ? ` × ${row.quantity}` : ""}
          <div className="mv-small mv-muted">
            {departmentLabel(row.department)} · {row.source === "direct-request" ? `logged by ${row.createdByName ?? "staff"}${row.externalReferrer ? ` for ${row.externalReferrer}` : ""}` : `recommended by ${row.createdByName ?? "clinician"}`} · {formatDateTime(row.createdAt)}
          </div>
        </div>
        <div className="mv-row"><PriorityBadge priority={row.priority} /><RequestStatusBadge status={row.status} /><BillingBadge status={row.billingStatus} /></div>
      </div>
      {row.instructions && !compact ? <p className="mv-small" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{row.instructions}</p> : null}
      {row.instructionsRestricted ? <p className="mv-small mv-muted" style={{ margin: 0 }}>Clinical instructions are visible to clinicians and the receiving department.</p> : null}
      {row.statusNote && ["declined", "cancelled", "completed"].includes(row.status) ? <p className="mv-small" style={{ margin: 0 }}><strong>{row.status === "completed" ? "Note" : "Reason"}:</strong> {row.statusNote}</p> : null}
      {row.completedAt ? <p className="mv-small mv-muted" style={{ margin: 0 }}>Completed {formatDateTime(row.completedAt)}{row.completedByName ? ` by ${row.completedByName}` : ""}</p> : null}
      {editing ? (
        <form className="mv-stack" onSubmit={save}>
          <div className="mv-form-grid">
            <Field label="Priority" htmlFor={`priority-${row.id}`}>
              <Select id={`priority-${row.id}`} value={priority} onChange={(event) => setPriority(event.target.value as Recommendation["priority"])}>
                <option value="routine">Routine</option><option value="urgent">Urgent</option><option value="emergency">Emergency</option>
              </Select>
            </Field>
          </div>
          <Field label="Instructions" htmlFor={`instructions-${row.id}`}><Textarea id={`instructions-${row.id}`} value={instructions} onChange={(event) => setInstructions(event.target.value)} maxLength={4000} /></Field>
          <div className="mv-row"><Button type="submit" size="sm" disabled={busy}>{busy ? "Saving…" : "Save changes"}</Button><Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button></div>
        </form>
      ) : null}
      <div className="mv-row mv-no-print">
        {row.canProgress ? (DEPARTMENT_ACTIONS[row.status] ?? []).map((next) => (
          <Button key={next.status} size="sm" variant={next.status === "declined" ? "ghost" : "secondary"} disabled={busy} onClick={() => transition(next.status, next.label, next.needsNote)}>{next.label}</Button>
        )) : null}
        {row.canEdit && !editing ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>Edit</Button> : null}
        {row.canCancel ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => transition("cancelled", "Cancel")}>Cancel request</Button> : null}
        <Button size="sm" variant="ghost" onClick={() => void toggleHistory()}>{history ? "Hide history" : "History"}</Button>
      </div>
      {history ? (
        <ol className="mv-small" style={{ margin: 0, paddingLeft: 18 }}>
          {history.map((event) => (
            <li key={event.id}>
              {formatDateTime(event.occurredAt)} · {event.actorName ?? "System"} · {event.event === "status-changed" ? `${event.fromStatus} → ${event.toStatus}` : event.event.replace("-", " ")}
              {event.note ? ` — ${event.note}` : ""}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function RecommendationForm({ encounterId, departments, consultation, catalogue, onCancel, onSaved }: {
  encounterId: string; departments: WorkflowDepartment[]; consultation: boolean; catalogue: CatalogueItem[]; onCancel: () => void; onSaved: (message: string) => void;
}) {
  const [department, setDepartment] = useState<WorkflowDepartment>(departments[0] ?? "laboratory");
  const [catalogItemId, setCatalogItemId] = useState("");
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [priority, setPriority] = useState("routine");
  const [instructions, setInstructions] = useState("");
  const [referrer, setReferrer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stable while the form is open, so a double click or retry records the request once.
  const key = useRef(crypto.randomUUID());
  const items = useMemo(() => catalogue.filter((item) => item.itemType !== "supply" && departmentForCategory(item.category) === department), [catalogue, department]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!catalogItemId && description.trim().length < 2) {
      setError("Choose a priced item or describe the service or procedure.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ recommendation: Recommendation; replayed?: boolean }>(`/encounters/${encounterId}/recommendations`, {
        method: "POST",
        headers: { "idempotency-key": `rec-${key.current}` },
        body: {
          department, catalogItemId: catalogItemId || null, description: catalogItemId ? undefined : description.trim(),
          quantity: Number(quantity) || 1, priority, instructions, externalReferrer: consultation ? "" : referrer,
        },
      });
      key.current = crypto.randomUUID();
      onSaved(`${response.recommendation.description} sent to ${departmentLabel(department).toLowerCase()}.`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mv-stack" onSubmit={submit}>
      {error ? <ErrorState title="Not sent" message={error} /> : null}
      <div className="mv-form-grid">
        <Field label="Department" htmlFor="rec-department">
          <Select id="rec-department" value={department} onChange={(event) => { setDepartment(event.target.value as WorkflowDepartment); setCatalogItemId(""); }}>
            {departments.map((value) => <option key={value} value={value}>{departmentLabel(value)}</option>)}
          </Select>
        </Field>
        <Field label="Service or procedure" htmlFor="rec-item" hint={items.length ? "From the price list." : "No priced items for this department yet; describe it below."}>
          <Select id="rec-item" value={catalogItemId} onChange={(event) => setCatalogItemId(event.target.value)}>
            <option value="">{items.length ? "Choose an item, or describe it below" : "Not on the price list"}</option>
            {items.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.code})</option>)}
          </Select>
        </Field>
      </div>
      {!catalogItemId ? (
        <Field label="Describe the request" htmlFor="rec-description" hint="Unpriced requests must be priced at the till before billing.">
          <Input id="rec-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={300} />
        </Field>
      ) : null}
      <div className="mv-form-grid">
        <Field label="Quantity" htmlFor="rec-quantity"><Input id="rec-quantity" type="number" min={1} step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></Field>
        <Field label="Priority" htmlFor="rec-priority">
          <Select id="rec-priority" value={priority} onChange={(event) => setPriority(event.target.value)}>
            <option value="routine">Routine</option><option value="urgent">Urgent</option><option value="emergency">Emergency</option>
          </Select>
        </Field>
        {!consultation ? <Field label="Requested by (optional)" htmlFor="rec-referrer" hint="Referring clinician or facility."><Input id="rec-referrer" value={referrer} onChange={(event) => setReferrer(event.target.value)} maxLength={300} /></Field> : null}
      </div>
      <Field label="Instructions for the department" htmlFor="rec-instructions" hint="Clinical question, site, fasting status, dose or preparation."><Textarea id="rec-instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} maxLength={4000} /></Field>
      <div className="mv-row"><Button type="submit" disabled={busy}>{busy ? "Sending…" : consultation ? "Send recommendation" : "Add request"}</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function SupplyForm({ encounterId, catalogue, requests, onCancel, onSaved }: {
  encounterId: string; catalogue: CatalogueItem[]; requests: Recommendation[]; onCancel: () => void; onSaved: (message: string) => void;
}) {
  const items = catalogue.filter((item) => item.itemType === "supply" || item.itemType === "pharmacy-item");
  const [catalogItemId, setCatalogItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [recommendationId, setRecommendationId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!catalogItemId) {
      setError("Choose the item supplied.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/encounters/${encounterId}/supplies`, {
        method: "POST", headers: { "idempotency-key": `supply-${key.current}` },
        body: { catalogItemId, quantity: Number(quantity), recommendationId: recommendationId || null, note },
      });
      key.current = crypto.randomUUID();
      onSaved("Supplied item recorded.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!items.length) {
    return <Notice tone="info" title="No supplies on the price list">Ask finance to add supplies or pharmacy items to the price list, then record them here. <Button size="sm" variant="ghost" onClick={onCancel}>Close</Button></Notice>;
  }
  return (
    <form className="mv-stack" onSubmit={submit}>
      {error ? <ErrorState title="Not recorded" message={error} /> : null}
      <div className="mv-form-grid">
        <Field label="Item" htmlFor="supply-item">
          <Select id="supply-item" value={catalogItemId} onChange={(event) => setCatalogItemId(event.target.value)}>
            <option value="">Choose an item</option>
            {items.map((item) => <option key={item.id} value={item.id}>{item.name}{item.unitOfMeasure ? ` (${item.unitOfMeasure})` : ""}</option>)}
          </Select>
        </Field>
        <Field label="Quantity" htmlFor="supply-quantity"><Input id="supply-quantity" type="number" min={0.01} step="any" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></Field>
        <Field label="For request (optional)" htmlFor="supply-request">
          <Select id="supply-request" value={recommendationId} onChange={(event) => setRecommendationId(event.target.value)}>
            <option value="">Not linked</option>
            {requests.map((request) => <option key={request.id} value={request.id}>{request.description}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Note (optional)" htmlFor="supply-note"><Input id="supply-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} /></Field>
      <div className="mv-row"><Button type="submit" disabled={busy}>{busy ? "Recording…" : "Record item"}</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}
