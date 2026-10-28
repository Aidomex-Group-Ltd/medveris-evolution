import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Notice, Table } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDate, formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

export interface FeedSource {
  id: string;
  name: string;
  sourceKind: string;
  baseUrl: string | null;
  ingestAdapter: string;
  ingestEnabled: boolean;
  status: string;
  fetchIntervalMinutes: number;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastItemCount: number | null;
  lastError: string | null;
  termsNote: string | null;
}

export interface ContentFeeds { canManage: boolean; sources: FeedSource[] }

interface NewsItem { id: string; title: string; summary: string; sourceUrl: string | null; sourceName: string | null; sourceOrganization: string | null; publicationDate: string | null; importedAt: string | null }

interface ImportedOpportunity { id: string; opportunityType: string; title: string; description: string; organization: string; applicationUrl: string | null; closesOn: string | null; sourceName: string | null }

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = { available: "success", configured: "warning", unavailable: "danger", disabled: "neutral" };

/** Text the server requires as an audit note; null when the user cancels or enters too little. */
export function promptNote(message: string): string | null {
  const note = window.prompt(message)?.trim() ?? "";
  return note.length >= 5 ? note : null;
}

export function useContentFeeds() {
  return useQuery<ContentFeeds>("/content-feeds");
}

export function ExternalSourcesCard({ feeds }: { feeds: ReturnType<typeof useContentFeeds> }) {
  const action = useAction();

  async function toggle(source: FeedSource) {
    const note = promptNote(`${source.ingestEnabled ? "Pause" : "Resume"} automatic import from ${source.name}? Enter a reason (at least 5 characters).`);
    if (!note) return;
    await action.run(`toggle-${source.id}`, async () => {
      await api(`/content-feeds/${source.id}/ingest`, { method: "POST", body: { enabled: !source.ingestEnabled, note } });
      feeds.reload();
      return source.ingestEnabled ? `Paused ${source.name}.` : `Resumed ${source.name}; it will be fetched on the next cycle.`;
    });
  }

  return (
    <Card title="Sources updated automatically" description="Headlines, short excerpts and links are imported from these official feeds and public APIs. Imported items are published without Medveris review; always check the original source.">
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}
      {feeds.loading ? <LoadingState rows={3} /> : feeds.error ? <ErrorState message={feeds.error} onRetry={feeds.reload} /> : !feeds.data?.sources.length ? <EmptyState title="No automatic sources" description="No official feeds are configured." /> : (
        <Table head={feeds.data.canManage ? ["Source", "Last updated", "Status", ""] : ["Source", "Last updated", "Status"]} caption="Automatic content sources">
          {feeds.data.sources.map((source) => (
            <tr key={source.id}>
              <td>
                <strong>{source.baseUrl ? <a href={source.baseUrl} target="_blank" rel="noreferrer">{source.name}</a> : source.name}</strong>
                {source.termsNote ? <div className="mv-small mv-muted">{source.termsNote}</div> : null}
              </td>
              <td className="mv-small">
                {source.lastSuccessAt ? formatDateTime(source.lastSuccessAt) : "Not yet imported"}
                {source.lastItemCount != null ? <div className="mv-muted">{source.lastItemCount} new item(s) last run</div> : null}
              </td>
              <td>
                <Badge tone={STATUS_TONE[source.status] ?? "neutral"}>{source.ingestEnabled ? source.status : "paused"}</Badge>
                {source.lastError ? <div className="mv-small mv-muted">{source.lastError}</div> : null}
              </td>
              {feeds.data!.canManage ? (
                <td><Button size="sm" variant="secondary" onClick={() => void toggle(source)} disabled={action.busy !== null}>{source.ingestEnabled ? "Pause" : "Resume"}</Button></td>
              ) : null}
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

/** Latest published items of one content type, linking to the original source. */
export function ExternalNewsCard({ title, description, contentType, limit = 6 }: { title: string; description: string; contentType: string; limit?: number }) {
  const news = useQuery<{ items: NewsItem[] }>(`/content?type=${contentType}&limit=${limit}`);
  return (
    <Card title={title} description={description}>
      {news.loading ? <LoadingState rows={4} /> : news.error ? <ErrorState message={news.error} onRetry={news.reload} /> : !news.data?.items.length ? <EmptyState title="Nothing yet" description="Items appear here after the next automatic import." /> : (
        <ul className="mv-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {news.data.items.map((item) => (
            <li key={item.id}>
              <strong>{item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.title}</a> : item.title}</strong>
              <div className="mv-small mv-muted">{item.sourceName ?? item.sourceOrganization ?? "Medveris"} · {formatDate(item.publicationDate)}{item.importedAt ? " · imported automatically" : ""}</div>
              <div className="mv-small">{item.summary}</div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Read-only list of imported fellowships, training and funding calls, linking to the funder's listing. */
export function ExternalOpportunitiesCard({ title, description, limit = 10 }: { title: string; description: string; limit?: number }) {
  const opportunities = useQuery<{ opportunities: ImportedOpportunity[] }>(`/opportunities?imported=true&limit=${limit}`);
  return (
    <Card title={title} description={description}>
      {opportunities.loading ? <LoadingState rows={4} /> : opportunities.error ? <ErrorState message={opportunities.error} onRetry={opportunities.reload} /> : !opportunities.data?.opportunities.length ? <EmptyState title="Nothing open right now" description="Open calls appear here after the next automatic import." /> : (
        <ul className="mv-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {opportunities.data.opportunities.map((row) => (
            <li key={row.id}>
              <strong>{row.applicationUrl ? <a href={row.applicationUrl} target="_blank" rel="noreferrer">{row.title}</a> : row.title}</strong>
              <div className="mv-small mv-muted">
                <Badge tone="info">{row.opportunityType.replaceAll("-", " ")}</Badge> {row.organization} · closes {row.closesOn ? formatDate(row.closesOn) : "date not stated"} · from {row.sourceName ?? "an official source"}
              </div>
              <div className="mv-small">{row.description}</div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
