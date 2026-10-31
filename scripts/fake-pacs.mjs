#!/usr/bin/env node
/**
 * Local synthetic PACS for exercising the DICOMweb workflow end to end.
 *
 *   npm run pacs:mock
 *
 * It serves QIDO-RS searches and WADO-RS rendered frames under /dicom-web with basic authentication,
 * mirroring the contract used by apps/api/src/integrations/dicomweb.ts. No patient data is real.
 * Configure the API with the values it prints, set FEATURE_DICOMWEB=true, then run the conformance
 * check from Admin -> Integrations as a platform operator. See docs/22_PACS_DICOMWEB_RUNBOOK.md.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PACS_PORT ?? 8042);
const BASE_PATH = "/dicom-web";
const USERNAME = process.env.PACS_USERNAME ?? "medveris";
const PASSWORD = process.env.PACS_PASSWORD ?? "synthetic-pacs-password";
const OPEN = process.env.PACS_OPEN === "true";
const ACCESSION = process.env.PACS_ACCESSION ?? "SYN-ACCESSION-1";
const FAMILY = process.env.PACS_FAMILY ?? "Synthetic";
const GIVEN = process.env.PACS_GIVEN ?? "Patient";
const BIRTH_DATE = (process.env.PACS_BIRTHDATE ?? "1992-06-15").replaceAll("-", "");
const SEX = process.env.PACS_SEX ?? "F";

/** Smallest valid PNG (1x1 grey pixel). */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==", "base64");
const CREDENTIALS = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;

let uidCounter = 0;
function uid() {
  uidCounter += 1;
  return `2.25.${Date.now()}${Math.floor(Math.random() * 1e6)}${uidCounter}`;
}

function study(accession) {
  const studyInstanceUid = uid();
  return {
    studyInstanceUid,
    accession,
    patientName: `${FAMILY}^${GIVEN}`,
    patientId: `SYN-${Math.floor(Math.random() * 1e8)}`,
    birthDate: BIRTH_DATE,
    sex: SEX,
    description: "SYNTHETIC CT HEAD",
    series: [
      {
        seriesInstanceUid: uid(),
        number: 1,
        instances: [{ sopInstanceUid: uid(), number: 1, frames: 4 }],
      },
      {
        seriesInstanceUid: uid(),
        number: 2,
        instances: [1, 2, 3].map((number) => ({ sopInstanceUid: uid(), number })),
      },
    ],
  };
}

const studies = [study(ACCESSION)];

const attr = (vr, ...values) => ({ vr, Value: values });

function studyJson(item) {
  return {
    "0020000D": attr("UI", item.studyInstanceUid),
    "00080050": attr("SH", item.accession),
    "00080020": attr("DA", "20261028"),
    "00081030": attr("LO", item.description),
    "00080061": attr("CS", "CT"),
    "00100010": attr("PN", { Alphabetic: item.patientName }),
    "00100020": attr("LO", item.patientId),
    "00100030": attr("DA", item.birthDate),
    "00100040": attr("CS", item.sex),
    "00201206": attr("IS", item.series.length),
    "00201208": attr("IS", item.series.reduce((sum, series) => sum + series.instances.length, 0)),
  };
}

function json(response, body, status = 200) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/dicom+json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

function findStudy(studyInstanceUid) {
  return studies.find((item) => item.studyInstanceUid === studyInstanceUid) ?? null;
}

function handle(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (!url.pathname.startsWith(BASE_PATH)) {
    response.writeHead(404).end("not found");
    return;
  }
  if (!OPEN && request.headers.authorization !== CREDENTIALS) {
    response.writeHead(401).end("unauthorized");
    return;
  }
  const path = url.pathname.slice(BASE_PATH.length).split("/").filter(Boolean);

  if (path.length === 1 && path[0] === "studies") {
    const accession = url.searchParams.get("AccessionNumber");
    const patientId = url.searchParams.get("PatientID");
    const studyInstanceUid = url.searchParams.get("StudyInstanceUID");
    const limit = Number(url.searchParams.get("limit") ?? 100);
    let matches = studies.filter((item) => (!accession || item.accession === accession)
      && (!patientId || item.patientId === patientId)
      && (!studyInstanceUid || item.studyInstanceUid === studyInstanceUid));
    if (!matches.length && accession && !studyInstanceUid && !patientId) {
      const created = study(accession);
      studies.push(created);
      matches = [created];
      console.log(`fake-pacs: created synthetic study ${created.studyInstanceUid} for accession ${accession}`);
    }
    if (!matches.length) {
      response.writeHead(204).end();
      return;
    }
    json(response, matches.slice(0, limit).map(studyJson));
    return;
  }

  const item = findStudy(path[1]);
  if (!item) {
    response.writeHead(404).end("not found");
    return;
  }
  if (path.length === 3 && path[2] === "series") {
    json(response, item.series.map((series) => ({
      "0020000E": attr("UI", series.seriesInstanceUid),
      "00080060": attr("CS", "CT"),
      "00200011": attr("IS", series.number),
      "0008103E": attr("LO", `Synthetic series ${series.number}`),
      "00201209": attr("IS", series.instances.length),
    })));
    return;
  }
  const series = item.series.find((candidate) => candidate.seriesInstanceUid === path[3]);
  if (!series) {
    response.writeHead(404).end("not found");
    return;
  }
  if (path.length === 5 && path[4] === "instances") {
    json(response, series.instances.map((instance) => ({
      "00080018": attr("UI", instance.sopInstanceUid),
      "00080016": attr("UI", "1.2.840.10008.5.1.4.1.1.2"),
      "00200013": attr("IS", instance.number),
      "00280010": attr("US", 256),
      "00280011": attr("US", 256),
      ...(instance.frames ? { "00280008": attr("IS", instance.frames) } : {}),
    })));
    return;
  }
  const instance = series.instances.find((candidate) => candidate.sopInstanceUid === path[5]);
  if (!instance) {
    response.writeHead(404).end("not found");
    return;
  }
  if (path.length === 9 && path[6] === "frames" && path[8] === "rendered") {
    if (Number(path[7]) > (instance.frames ?? 1)) {
      response.writeHead(400).end("bad frame");
      return;
    }
    response.writeHead(200, { "content-type": "image/png", "content-length": PNG.byteLength });
    response.end(PNG);
    return;
  }
  response.writeHead(404).end("not found");
}

const server = createServer(handle);
server.listen(PORT, () => {
  const base = `http://localhost:${PORT}${BASE_PATH}`;
  console.log("fake-pacs: synthetic DICOMweb server");
  console.log(`  DICOMWEB_BASE_URL=${base}`);
  console.log(`  DICOMWEB_AUTH=${OPEN ? "none" : "basic"}`);
  if (!OPEN) {
    console.log(`  DICOMWEB_USERNAME=${USERNAME}`);
    console.log("  DICOMWEB_PASSWORD=<PACS_PASSWORD or synthetic-pacs-password>");
  }
  console.log(`  sample accession: ${ACCESSION}`);
  console.log(`  sample Study Instance UID: ${studies[0].studyInstanceUid}`);
  console.log("  identity: " + `${FAMILY}^${GIVEN}`, BIRTH_DATE, SEX);
  console.log("Press Ctrl+C to stop. No real patient data is served.");
});
