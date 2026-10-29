import { useState, type FormEvent } from "react";
import { Badge, Button, Card, EmptyState, Field, Input, LoadingState, Notice, Table, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/useAction";
import { useQuery } from "../lib/useQuery";

interface ImagesState { state: string; reason: string; available: boolean; verifiedAt: string | null }
interface Identity { familyName: string; givenName: string; birthDate: string; sex: string; confirmed: boolean }
interface PacsPatient { name: string | null; patientId: string | null; birthDate: string | null; sex: string | null }
interface Candidate {
  studyInstanceUid: string; accession: string | null; studyDate: string | null; description: string | null; modalities: string[];
  seriesCount: number | null; instanceCount: number | null; patient: PacsPatient; accessionMatches: boolean; identity: Identity;
}
interface StudyDetail {
  study: { id: string; accession: string | null; pacsState: string; studyInstanceUid: string | null; pacsLinkedAt: string | null; linkedByName: string | null; version: number };
  images: ImagesState;
  permissions: { link: boolean; view: boolean };
}
interface Series { seriesInstanceUid: string; modality: string | null; seriesNumber: number | null; description: string | null; instanceCount: number | null }
interface Instance { sopInstanceUid: string; instanceNumber: number | null; frames: number }

function identityTone(value: string): "success" | "danger" | "neutral" {
  return value === "match" ? "success" : value === "mismatch" ? "danger" : "neutral";
}

function frameUrl(studyId: string, series: string, instance: string, size: "thumb" | "full"): string {
  return `/api/v1/radiology/studies/${studyId}/images/series/${series}/instances/${instance}/frames/1?size=${size}`;
}

/** PACS link and rendered-image review for one imaging study. Never shown as a diagnostic viewer. */
export function PacsImagesPanel({ studyId }: { studyId: string }) {
  const detail = useQuery<StudyDetail>(`/radiology/studies/${studyId}`);
  if (detail.loading && !detail.data) return <LoadingState label="Loading PACS status" />;
  if (!detail.data) return <Notice tone="warning" title="Images">{detail.error ?? "PACS status is unavailable."}</Notice>;
  const { study, images, permissions } = detail.data;
  if (!images.available) {
    return <Notice tone="warning" title={`Images: DICOMweb ${images.state.replace("_", " ")}`}>{images.reason}. No images are shown or attached to this report.</Notice>;
  }
  return study.pacsState === "reconciled" && study.studyInstanceUid
    ? <LinkedStudy studyId={studyId} detail={detail.data} reload={detail.reload} canView={permissions.view} canLink={permissions.link} />
    : <LinkStudy studyId={studyId} detail={detail.data} reload={detail.reload} canLink={permissions.link} />;
}

function LinkStudy({ studyId, detail, reload, canLink }: { studyId: string; detail: StudyDetail; reload: () => void; canLink: boolean }) {
  const action = useAction();
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [patientId, setPatientId] = useState("");
  const [override, setOverride] = useState<Record<string, string>>({});

  async function search(event: FormEvent) {
    event.preventDefault();
    await action.run("search", async () => {
      const query = patientId.trim() ? `?patientId=${encodeURIComponent(patientId.trim())}` : "";
      const result = await api<{ candidates: Candidate[] }>(`/radiology/studies/${studyId}/pacs-candidates${query}`);
      setCandidates(result.candidates);
      return result.candidates.length ? undefined : "The PACS returned no matching studies.";
    });
  }

  async function link(candidate: Candidate) {
    await action.run(`link-${candidate.studyInstanceUid}`, async () => {
      const reason = override[candidate.studyInstanceUid]?.trim();
      await api(`/radiology/studies/${studyId}/pacs-link`, {
        method: "POST",
        body: { studyInstanceUid: candidate.studyInstanceUid, expectedVersion: detail.study.version, ...(reason ? { identityOverrideReason: reason } : {}) },
      });
      reload();
      return "PACS study linked.";
    });
  }

  return (
    <Card title="Images (PACS)" description={`Verified PACS connection${detail.images.verifiedAt ? ` · last verified ${formatDateTime(detail.images.verifiedAt)}` : ""}. This study is not linked to a PACS study yet.`}>
      {!canLink ? <EmptyState title="Not linked" description="A radiographer or radiologist links this study to its PACS study after comparing the patient identity." /> : (
        <div className="mv-stack">
          <form className="mv-row" onSubmit={search}>
            <Field label="PACS patient ID (optional)" hint={`Leave empty to search by accession ${detail.study.accession ?? ""}`} htmlFor="pacs-patient-id">
              <Input id="pacs-patient-id" value={patientId} onChange={(event) => setPatientId(event.target.value)} maxLength={64} />
            </Field>
            <Button type="submit" disabled={action.busy === "search"}>{action.busy === "search" ? "Searching…" : "Search PACS"}</Button>
          </form>
          {action.error ? <Notice tone="danger">{action.error}</Notice> : null}
          {action.message ? <Notice tone="info">{action.message}</Notice> : null}
          {candidates?.length ? (
            <Table head={["Study", "PACS patient", "Identity check", "Link"]}>
              {candidates.map((candidate) => (
                <tr key={candidate.studyInstanceUid}>
                  <td>
                    <div>{candidate.description ?? "Untitled study"} · {candidate.modalities.join(", ")}</div>
                    <div className="mv-small mv-muted">{candidate.studyDate ?? "no date"} · accession {candidate.accession ?? "—"} {candidate.accessionMatches ? <Badge tone="success">accession matches</Badge> : null}</div>
                  </td>
                  <td>{candidate.patient.name ?? "—"}<div className="mv-small mv-muted">DOB {candidate.patient.birthDate ?? "—"} · sex {candidate.patient.sex ?? "—"}</div></td>
                  <td>
                    <div className="mv-row">
                      <Badge tone={identityTone(candidate.identity.familyName)}>family name {candidate.identity.familyName}</Badge>
                      <Badge tone={identityTone(candidate.identity.birthDate)}>DOB {candidate.identity.birthDate}</Badge>
                      <Badge tone={identityTone(candidate.identity.sex)}>sex {candidate.identity.sex}</Badge>
                    </div>
                    {!candidate.identity.confirmed ? (
                      <Field label="Reason to link despite the mismatch" htmlFor={`override-${candidate.studyInstanceUid}`}>
                        <Textarea id={`override-${candidate.studyInstanceUid}`} rows={2} value={override[candidate.studyInstanceUid] ?? ""}
                          onChange={(event) => setOverride((current) => ({ ...current, [candidate.studyInstanceUid]: event.target.value }))} />
                      </Field>
                    ) : null}
                  </td>
                  <td>
                    <Button variant="secondary" onClick={() => void link(candidate)}
                      disabled={action.busy !== null || (!candidate.identity.confirmed && (override[candidate.studyInstanceUid]?.trim().length ?? 0) < 10)}>
                      Link
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function LinkedStudy({ studyId, detail, reload, canView, canLink }: { studyId: string; detail: StudyDetail; reload: () => void; canView: boolean; canLink: boolean }) {
  const action = useAction();
  const images = useQuery<{ series: Series[]; notice: string }>(canView ? `/radiology/studies/${studyId}/images` : null);
  const [openSeries, setOpenSeries] = useState<string | null>(null);
  const instances = useQuery<{ instances: Instance[] }>(openSeries ? `/radiology/studies/${studyId}/images/series/${openSeries}` : null);
  const [shown, setShown] = useState<string | null>(null);
  const [unlinkReason, setUnlinkReason] = useState("");

  async function unlink(event: FormEvent) {
    event.preventDefault();
    await action.run("unlink", async () => {
      await api(`/radiology/studies/${studyId}/pacs-unlink`, { method: "POST", body: { expectedVersion: detail.study.version, reason: unlinkReason } });
      reload();
      return "PACS link removed.";
    });
  }

  return (
    <Card title="Images (PACS)" description={`Linked ${detail.study.pacsLinkedAt ? formatDateTime(detail.study.pacsLinkedAt) : ""}${detail.study.linkedByName ? ` by ${detail.study.linkedByName}` : ""}.`}>
      <div className="mv-stack">
        {!canView ? <Notice tone="info">Your role cannot view images.</Notice> : null}
        {images.error ? <Notice tone="danger">{images.error}</Notice> : null}
        {images.data ? <Notice tone="warning">{images.data.notice}</Notice> : null}
        {images.data?.series.length ? (
          <Table head={["Series", "Modality", "Images", ""]}>
            {images.data.series.map((series) => (
              <tr key={series.seriesInstanceUid}>
                <td>#{series.seriesNumber ?? "—"} {series.description ?? ""}</td>
                <td>{series.modality ?? "—"}</td>
                <td>{series.instanceCount ?? "—"}</td>
                <td><Button variant="secondary" onClick={() => { setOpenSeries(series.seriesInstanceUid); setShown(null); }}>Open</Button></td>
              </tr>
            ))}
          </Table>
        ) : images.data ? <EmptyState title="No series" description="The PACS holds no series for this study." /> : null}
        {openSeries && instances.data ? (
          <div className="mv-row" style={{ flexWrap: "wrap" }}>
            {instances.data.instances.map((instance) => (
              <button key={instance.sopInstanceUid} type="button" className="mv-thumb" onClick={() => setShown(instance.sopInstanceUid)}
                aria-label={`Image ${instance.instanceNumber ?? ""}`}>
                <img src={frameUrl(studyId, openSeries, instance.sopInstanceUid, "thumb")} alt={`Instance ${instance.instanceNumber ?? ""}`} width={96} height={96} loading="lazy" />
              </button>
            ))}
          </div>
        ) : null}
        {openSeries && shown ? <img src={frameUrl(studyId, openSeries, shown, "full")} alt="Rendered review image" style={{ maxWidth: "100%" }} /> : null}
        {canLink ? (
          <form className="mv-stack" onSubmit={unlink}>
            <Field label="Reason to unlink" hint="At least 10 characters; recorded in the audit trail" htmlFor="pacs-unlink-reason">
              <Input id="pacs-unlink-reason" value={unlinkReason} onChange={(event) => setUnlinkReason(event.target.value)} />
            </Field>
            <div><Button type="submit" variant="secondary" disabled={unlinkReason.trim().length < 10 || action.busy === "unlink"}>Unlink PACS study</Button></div>
          </form>
        ) : null}
        {action.error ? <Notice tone="danger">{action.error}</Notice> : null}
        {action.message ? <Notice tone="info">{action.message}</Notice> : null}
      </div>
    </Card>
  );
}
