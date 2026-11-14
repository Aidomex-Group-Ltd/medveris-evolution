import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/api/src/config.js";
import { DicomwebClient, dicomwebConfigProblems, dicomwebFingerprint, PacsError } from "../../apps/api/src/integrations/dicomweb.js";

const strong = {
  SESSION_SECRET: "a".repeat(20) + "Session-Secret-Value-1",
  AUDIT_SIGNING_KEY: "b".repeat(20) + "Audit-Signing-Value-2",
  MFA_ENCRYPTION_KEY: "c".repeat(20) + "Mfa-Encryption-Value-3",
};
const staging = { ...strong, APP_ENV: "staging", APP_ORIGIN: "https://medveris-staging.example.workers.dev" };

describe("DICOMWEB transport", () => {
  it("defaults to url and accepts vpc explicitly", () => {
    expect(loadConfig(staging).dicomweb.transport).toBe("url");
    expect(loadConfig({ ...staging, DICOMWEB_TRANSPORT: "vpc" }).dicomweb.transport).toBe("vpc");
  });

  it("rejects an unknown DICOMWEB_TRANSPORT at startup", () => {
    expect(() => loadConfig({ ...staging, DICOMWEB_TRANSPORT: "carrier-pigeon" }))
      .toThrow("DICOMWEB_TRANSPORT must be url or vpc");
  });

  it("requires HTTPS for url transport outside local development", () => {
    const problems = dicomwebConfigProblems(loadConfig({ ...staging, DICOMWEB_BASE_URL: "http://pacs/dicom-web" }));
    expect(problems.some((problem) => problem.includes("must use HTTPS"))).toBe(true);
  });

  it("allows http for vpc transport because the host is a routing label, not an address", () => {
    const config = loadConfig({ ...staging, DICOMWEB_TRANSPORT: "vpc", DICOMWEB_BASE_URL: "http://medveris-pacs/dicom-web", DICOMWEB_AUTH: "basic", DICOMWEB_USERNAME: "orthanc", DICOMWEB_PASSWORD: "secret-value" });
    expect(dicomwebConfigProblems(config)).toEqual([]);
  });

  it("keeps the structural rules in vpc transport (no embedded credentials, no query)", () => {
    const config = loadConfig({ ...staging, DICOMWEB_TRANSPORT: "vpc", DICOMWEB_BASE_URL: "http://orthanc:pw@medveris-pacs/dicom-web?x=1", DICOMWEB_AUTH: "basic", DICOMWEB_USERNAME: "orthanc", DICOMWEB_PASSWORD: "secret-value" });
    const problems = dicomwebConfigProblems(config);
    expect(problems.some((problem) => problem.includes("credentials"))).toBe(true);
    expect(problems.some((problem) => problem.includes("query"))).toBe(true);
  });

  it("distinguishes verification fingerprints between transports", async () => {
    const url = loadConfig({ ...staging, DICOMWEB_BASE_URL: "https://pacs/dicom-web", DICOMWEB_AUTH: "basic", DICOMWEB_USERNAME: "orthanc", DICOMWEB_PASSWORD: "secret-value" }).dicomweb;
    const vpc = loadConfig({ ...staging, DICOMWEB_TRANSPORT: "vpc", DICOMWEB_BASE_URL: "https://pacs/dicom-web", DICOMWEB_AUTH: "basic", DICOMWEB_USERNAME: "orthanc", DICOMWEB_PASSWORD: "secret-value" }).dicomweb;
    expect(await dicomwebFingerprint(url)).not.toBe(await dicomwebFingerprint(vpc));
  });
});

describe("DICOMweb over a VPC binding", () => {
  it("routes every call through the binding and keeps the base URL path", async () => {
    const seen: string[] = [];
    const vpcBinding = async (input: string): Promise<Response> => {
      seen.push(input);
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/dicom+json" } });
    };
    const client = new DicomwebClient(
      { baseUrl: "http://medveris-pacs/dicom-web", auth: "basic", username: "orthanc", password: "pw", bearerToken: null, timeoutMs: 5_000, maxImageBytes: 20 * 1024 * 1024, verificationMaxAgeDays: 30, transport: "vpc" },
      vpcBinding,
    );
    await expect(client.searchStudies({ accession: "SYN001", limit: 5 })).resolves.toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^http:\/\/medveris-pacs\/dicom-web\/studies\?/);
  });

  it("reports an unreachable PACS when the binding itself fails", async () => {
    const vpcBinding = async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    };
    const client = new DicomwebClient(
      { baseUrl: "http://medveris-pacs/dicom-web", auth: "basic", username: "orthanc", password: "pw", bearerToken: null, timeoutMs: 1_000, maxImageBytes: 20 * 1024 * 1024, verificationMaxAgeDays: 30, transport: "vpc" },
      vpcBinding,
    );
    await expect(client.searchStudies({ accession: "SYN001", limit: 5 }))
      .rejects.toMatchObject({ failure: "unreachable" });
  });

  it("is a PacsError for typed refinements", async () => {
    const vpcBinding = async (): Promise<Response> => new Response("unauthorized", { status: 401 });
    const client = new DicomwebClient(
      { baseUrl: "http://medveris-pacs/dicom-web", auth: "basic", username: "orthanc", password: "wrong", bearerToken: null, timeoutMs: 1_000, maxImageBytes: 20 * 1024 * 1024, verificationMaxAgeDays: 30, transport: "vpc" },
      vpcBinding,
    );
    await expect(client.searchStudies({ accession: "SYN001", limit: 5 }))
      .rejects.toBeInstanceOf(PacsError);
  });
});
