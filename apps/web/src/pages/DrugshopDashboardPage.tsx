import { useState } from "react";
import { Badge, Card, DataList, EmptyState, ErrorState, LoadingState, Notice, PageHeader, Table } from "@medveris/ui";
import { Link } from "react-router-dom";
import { useQuery } from "../lib/useQuery";
import { formatDate, formatDateTime, formatMoney } from "../lib/format";

interface LicenceView {
  kind: string; label: string; identifier: string; status: string; validUntil: string | null;
  issuer: string | null; verifiedAt: string | null; documentReference: string | null;
}

interface ExperienceView {
  facility: { id: string; name: string; slug: string; status: string; city: string | null; district: string | null; country: string };
  experience: "drugshop" | "pharmacy" | "facility";
  access: { status: "ready" | "restricted"; reasons: string[]; warnings: string[] };
  licence: LicenceView | null;
  licenceStatus: string;
  licenceNotice: string;
  registrations: Array<{ kind: string; identifier: string; status: string; validUntil: string | null; issuer: string | null }>;
  routes: { home: string; priceLists: string; sales: string; licence: string };
}

interface Overview {
  facility: { id: string; name: string; status: string; city: string | null; district: string | null; country: string };
  licence: LicenceView | null;
  licenceStatus: string;
  licenceNotice: string;
  access: ExperienceView["access"];
  stock: { stockedItems: number; lowStock: number; outOfStock: number };
  classifications: Array<{ dispensingScope: string; count: number }>;
  today: { transactions: number; total: number; currency: string };
  recentSales: Array<{ id: string; saleNumber: string; total: number; currency: string; paymentMethod: string; status: string; createdAt: string }>;
  expiring: Array<{ id: string; lotNumber: string; expiresOn: string; name: string; onHand: number }>;
  pendingReceipts: Array<{ id: string; poNumber: string; status: string; expectedOn: string | null; supplierName: string | null }>;
  priceLists: Array<{ id: string; code: string; name: string; status: string; effectiveFrom: string; effectiveTo: string | null; itemCount: number; currency: string | null }>;
  activePriceList: { id: string; code: string; name: string; status: string; itemCount: number; currency: string | null } | null;
}

const LICENCE_STATUS_LABELS: Record<string, string> = {
  "not-provided": "Not provided",
  "pending-verification": "Provided — pending verification",
  verified: "Verified",
  rejected: "Verification rejected",
  expired: "Expired",
  withdrawn: "Withdrawn",
};

const SCOPE_LABELS: Record<string, string> = {
  otc: "Over the counter (a Drugshop may sell)",
  "prescription-only": "Prescription only (a Drugshop may not sell)",
  "pharmacy-only": "Pharmacy only (a Drugshop may not sell)",
  "not-dispensable": "Not for retail dispensing",
  unverified: "Not classified (no Drugshop sale permitted)",
};

const PAYMENT_LABELS: Record<string, string> = {
  cash: "Cash",
  "mobile-money": "Mobile money",
  "bank-transfer": "Bank transfer",
  card: "Card",
  manual: "Manual",
};

function licenceTone(status: string | undefined): "success" | "warning" | "danger" | "neutral" {
  if (status === "verified") return "success";
  if (status === "pending-verification" || status === "rejected") return "warning";
  if (status === "expired" || status === "withdrawn") return "danger";
  return "neutral";
}

/**
 * The Drugshop's own dashboard.
 *
 * It is deliberately not the Pharmacy dashboard: it shows a shop's stock, today's takings,
 * expiries, purchases and its own price list. A regulatory licence is optional documentation
 * here: the dashboard opens whether or not one is recorded, and the licence notice is
 * informational and dismissible. Only a regulated medicine sale needs a verified licence.
 */
export function DrugshopDashboardPage() {
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const experience = useQuery<ExperienceView>("/facility/experience");
  const isDrugshop = experience.data?.experience === "drugshop";
  const overview = useQuery<Overview>("/drugshop/overview", { enabled: isDrugshop });

  if (experience.loading) return <LoadingState label="Loading the Drugshop workspace" variant="page" />;
  if (experience.error) return <ErrorState message={experience.error} onRetry={experience.reload} />;
  if (!experience.data) return <EmptyState title="Workspace unavailable" description="The facility context could not be loaded. Refresh to try again." />;

  const view = experience.data;
  const licence = view.licence;
  const licenceStatus = view.licence?.status ?? view.licenceStatus ?? "not-provided";
  const data = overview.data;

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Drugshop"
        title={view.facility.name}
        description="Stock, sales and the shop's own price list. Only items classified for over-the-counter sale can be dispensed here."
      />

      {!noticeDismissed && licenceStatus !== "verified" ? (
        <Notice
          tone="info"
          title={`Licence details · ${LICENCE_STATUS_LABELS[licenceStatus] ?? licenceStatus}`}
          onDismiss={() => setNoticeDismissed(true)}
        >
          <p>{view.licenceNotice ?? view.access.warnings[0] ?? "Licence details have not been provided. You can continue using MedVeris and add your regulatory licence information whenever available."}</p>
          <p className="mv-small">
            A verified licence is needed only to sell medicines; stock, catalogue, suppliers, price lists and reports stay available.{" "}
            <Link to={view.routes.licence}>Add or update licence details</Link>
          </p>
        </Notice>
      ) : null}

      <Card title="Licence" description="Optional regulatory documentation for this workspace. You can use MedVeris without it.">
        <DataList
          items={[
            { label: "Facility", value: `${view.facility.name}${view.facility.district ? ` · ${view.facility.district}` : ""}${view.facility.city ? `, ${view.facility.city}` : ""}` },
            {
              label: "NDA drug shop licence",
              value: licence ? `${licence.identifier}${licence.validUntil ? ` · valid until ${formatDate(licence.validUntil)}` : ""}` : "Not provided",
            },
            { label: "Status", value: <Badge tone={licenceTone(licenceStatus)}>{LICENCE_STATUS_LABELS[licenceStatus] ?? licenceStatus}</Badge> },
            ...(licence?.issuer ? [{ label: "Issuing authority", value: licence.issuer }] : []),
            ...(licence?.verifiedAt ? [{ label: "Verified on", value: formatDate(licence.verifiedAt) }] : []),
            ...(licence?.documentReference ? [{ label: "Supporting document", value: licence.documentReference }] : []),
            { label: "Registration status", value: view.facility.status },
          ]}
        />
        <p className="mv-small mv-muted">
          <Link to={view.routes.licence}>Manage licence details</Link>
        </p>
      </Card>

      {overview.error ? <ErrorState message={overview.error} onRetry={overview.reload} /> : null}
      {overview.loading && !data ? <LoadingState label="Loading today's figures" /> : null}

      <section className="mv-grid mv-grid--3" aria-label="Shop status">
        <div className="mv-stat">
          <span>Items in stock</span>
          <strong>{data ? data.stock.stockedItems : "…"}</strong>
          <span>Active items with a balance above zero</span>
        </div>
        <div className="mv-stat">
          <span>Low stock</span>
          <strong>{data ? data.stock.lowStock : "…"}</strong>
          <span>At or below the recorded reorder level</span>
        </div>
        <div className="mv-stat">
          <span>Out of stock</span>
          <strong>{data ? data.stock.outOfStock : "…"}</strong>
          <span>Active items with nothing available</span>
        </div>
      </section>

      <section className="mv-grid mv-grid--2" aria-label="Today">
        <div className="mv-stat">
          <span>Today's sales</span>
          <strong>{data ? formatMoney(data.today.total, data.today.currency) : "…"}</strong>
          <span>{data ? `${data.today.transactions} completed transaction${data.today.transactions === 1 ? "" : "s"}` : "Completed sales since midnight"}</span>
        </div>
        <div className="mv-stat">
          <span>Active price list</span>
          <strong>{data?.activePriceList ? data.activePriceList.name : "None yet"}</strong>
          <span>
            {data?.activePriceList
              ? `${data.activePriceList.status} · ${data.activePriceList.itemCount} item(s)${data.activePriceList.currency ? ` · ${data.activePriceList.currency}` : ""}`
              : "Create the shop's own list from the global catalogue"}
          </span>
          <Link to={view.routes.priceLists}>Manage price lists</Link>
        </div>
      </section>

      <Card title="What this shop may dispense" description="A catalogue entry is not a dispensing authorisation. Each item must be classified.">
        {data && data.classifications.length ? (
          <Table head={["Classification", "Items"]}>
            {data.classifications.map((row) => (
              <tr key={row.dispensingScope}>
                <td>{SCOPE_LABELS[row.dispensingScope] ?? row.dispensingScope}</td>
                <td>{row.count}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <EmptyState title="No stock recorded yet" description="Once items are added to inventory, their dispensing classification appears here." />
        )}
        <Notice tone="info" title="Server-enforced">
          A sale containing prescription-only, pharmacy-only or unclassified items is refused by the API and recorded in the audit trail, even if the request is sent directly.
        </Notice>
      </Card>

      <div className="mv-grid mv-grid--2">
        <Card title="Recent transactions" description="The last five sales at this shop.">
          {data?.recentSales.length ? (
            <Table head={["Sale", "Total", "Payment", "When"]}>
              {data.recentSales.map((sale) => (
                <tr key={sale.id}>
                  <td>{sale.saleNumber}{sale.status === "voided" ? " (voided)" : ""}</td>
                  <td>{formatMoney(sale.total, sale.currency)}</td>
                  <td>{PAYMENT_LABELS[sale.paymentMethod] ?? sale.paymentMethod}</td>
                  <td>{formatDateTime(sale.createdAt)}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title="No sales yet" description="Completed sales appear here as soon as the shop records its first transaction." />
          )}
        </Card>

        <Card title="Expiring stock" description="Batches expiring within 90 days.">
          {data?.expiring.length ? (
            <Table head={["Item", "Batch", "Expires", "On hand"]}>
              {data.expiring.map((lot) => (
                <tr key={lot.id}>
                  <td>{lot.name}</td>
                  <td>{lot.lotNumber || "—"}</td>
                  <td>{formatDate(lot.expiresOn)}</td>
                  <td>{lot.onHand}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title="Nothing expiring soon" description="No available batch at this shop expires in the next 90 days." />
          )}
        </Card>
      </div>

      <div className="mv-grid mv-grid--2">
        <Card title="Pending supplier receipts" description="Orders submitted or approved and not yet fully received.">
          {data?.pendingReceipts.length ? (
            <Table head={["Order", "Supplier", "Status", "Expected"]}>
              {data.pendingReceipts.map((order) => (
                <tr key={order.id}>
                  <td>{order.poNumber}</td>
                  <td>{order.supplierName ?? "—"}</td>
                  <td>{order.status}</td>
                  <td>{order.expectedOn ? formatDate(order.expectedOn) : "—"}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState title="No pending receipts" description="Purchase orders awaiting delivery appear here." />
          )}
        </Card>

        <Card title="Facility price lists" description="This shop's own prices. A published list is what staff charge.">
          {data?.priceLists.length ? (
            <Table head={["List", "Status", "Items", "Effective"]}>
              {data.priceLists.map((list) => (
                <tr key={list.id}>
                  <td>{list.name}</td>
                  <td><Badge tone={list.status === "PUBLISHED" ? "success" : "neutral"}>{list.status}</Badge></td>
                  <td>{list.itemCount}</td>
                  <td>{formatDate(list.effectiveFrom)}{list.effectiveTo ? ` – ${formatDate(list.effectiveTo)}` : ""}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState
              title="No price list yet"
              description="Create a draft from the global catalogue, set this shop's prices, then submit it for approval."
              action={<Link to={view.routes.priceLists}>Open price lists</Link>}
            />
          )}
        </Card>
      </div>
    </div>
  );
}
