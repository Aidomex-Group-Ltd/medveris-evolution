/**
 * In-process DICOMweb server with synthetic studies, used as the PACS transport in tests. It answers
 * QIDO-RS searches and WADO-RS rendered frames the way Orthanc does, requires basic credentials and
 * records every URL so tests can check what Medveris asked for.
 */

export interface FakeStudy {
  studyInstanceUid: string;
  accession: string;
  patientName: string;
  patientId: string;
  birthDate: string;
  sex: string;
  modality: string;
  description: string;
  series: Array<{ seriesInstanceUid: string; number: number; instances: Array<{ sopInstanceUid: string; number: number; frames?: number }> }>;
}

/** Smallest valid PNG (1x1 grey pixel). */
export const PNG_PIXEL = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0));

let uidCounter = 0;
export function syntheticUid(): string {
  uidCounter += 1;
  return `2.25.${Date.now()}${Math.floor(Math.random() * 1e6)}${uidCounter}`;
}

export function syntheticStudy(input: { accession: string; family: string; given: string; birthDate: string; sex: string; slices?: number }): FakeStudy {
  return {
    studyInstanceUid: syntheticUid(),
    accession: input.accession,
    patientName: `${input.family}^${input.given}`,
    patientId: `SYN-${Math.floor(Math.random() * 1e8)}`,
    birthDate: input.birthDate.replace(/-/g, ""),
    sex: input.sex,
    modality: "CT",
    description: "SYNTHETIC CT HEAD",
    series: [
      { seriesInstanceUid: syntheticUid(), number: 2, instances: Array.from({ length: input.slices ?? 3 }, (_, index) => ({ sopInstanceUid: syntheticUid(), number: index + 1 })) },
      { seriesInstanceUid: syntheticUid(), number: 1, instances: [{ sopInstanceUid: syntheticUid(), number: 1, frames: 4 }] },
    ],
  };
}

const attr = (vr: string, ...values: unknown[]) => ({ vr, Value: values });

export class FakePacs {
  readonly studies: FakeStudy[] = [];
  readonly requests: string[] = [];
  credentials = `Basic ${btoa("medveris:synthetic-pacs-password")}`;
  /** Set to make every request fail at the transport, as an unreachable PACS does. */
  offline = false;
  /** Answer unauthenticated requests too, as a misconfigured open PACS does. */
  open = false;

  constructor(readonly baseUrl: string) {}

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    this.requests.push(input);
    if (this.offline) throw new TypeError("fetch failed");
    const headers = new Headers(init?.headers);
    if (!this.open && headers.get("authorization") !== this.credentials) return new Response("unauthorized", { status: 401 });
    const url = new URL(input);
    if (!input.startsWith(this.baseUrl)) return new Response("not found", { status: 404 });
    const path = url.pathname.slice(new URL(this.baseUrl).pathname.length).split("/").filter(Boolean);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/dicom+json" } });
    if (path.length === 1 && path[0] === "studies") {
      const accession = url.searchParams.get("AccessionNumber");
      const patientId = url.searchParams.get("PatientID");
      const uid = url.searchParams.get("StudyInstanceUID");
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const matches = this.studies.filter((study) => (!accession || study.accession === accession)
        && (!patientId || study.patientId === patientId) && (!uid || study.studyInstanceUid === uid)).slice(0, limit);
      return matches.length ? json(matches.map((study) => this.studyJson(study))) : new Response(null, { status: 204 });
    }
    const study = this.studies.find((candidate) => candidate.studyInstanceUid === path[1]);
    if (!study) return new Response("not found", { status: 404 });
    if (path.length === 3 && path[2] === "series") {
      return json(study.series.map((series) => ({
        "0020000E": attr("UI", series.seriesInstanceUid), "00080060": attr("CS", study.modality), "00200011": attr("IS", series.number),
        "0008103E": attr("LO", `Synthetic series ${series.number}`), "00201209": attr("IS", series.instances.length),
      })));
    }
    const series = study.series.find((candidate) => candidate.seriesInstanceUid === path[3]);
    if (!series) return new Response("not found", { status: 404 });
    if (path.length === 5 && path[4] === "instances") {
      return json(series.instances.map((instance) => ({
        "00080018": attr("UI", instance.sopInstanceUid), "00080016": attr("UI", "1.2.840.10008.5.1.4.1.1.2"),
        "00200013": attr("IS", instance.number), "00280010": attr("US", 256), "00280011": attr("US", 256),
        ...(instance.frames ? { "00280008": attr("IS", instance.frames) } : {}),
      })));
    }
    const instance = series.instances.find((candidate) => candidate.sopInstanceUid === path[5]);
    if (!instance) return new Response("not found", { status: 404 });
    if (path.length === 9 && path[6] === "frames" && path[8] === "rendered") {
      if (Number(path[7]) > (instance.frames ?? 1)) return new Response("bad frame", { status: 400 });
      return new Response(PNG_PIXEL, { status: 200, headers: { "content-type": "image/png", "content-length": String(PNG_PIXEL.byteLength) } });
    }
    return new Response("not found", { status: 404 });
  };

  private studyJson(study: FakeStudy) {
    return {
      "0020000D": attr("UI", study.studyInstanceUid), "00080050": attr("SH", study.accession), "00080020": attr("DA", "20261028"),
      "00081030": attr("LO", study.description), "00080061": attr("CS", study.modality),
      "00100010": attr("PN", { Alphabetic: study.patientName }), "00100020": attr("LO", study.patientId),
      "00100030": attr("DA", study.birthDate), "00100040": attr("CS", study.sex),
      "00201206": attr("IS", study.series.length), "00201208": attr("IS", study.series.reduce((sum, series) => sum + series.instances.length, 0)),
    };
  }
}
