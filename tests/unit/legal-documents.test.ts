import { describe, expect, it } from "vitest";
import {
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_IDS,
  LEGAL_REVIEW_NOTICE,
  currentLegalDocument,
  legalDocumentDigest,
  type LegalKind,
} from "../../apps/api/src/legal/documents.js";
import { requireLegalAcceptance } from "../../apps/api/src/lib/legal.js";

/**
 * The published rows in migration 108 are the version reference every acceptance points at. Editing
 * a bundled document in place would silently change what people accepted, so changing the content
 * must bump the version and publish a new row; this test fails until the two agree again.
 */
const PUBLISHED: Record<LegalKind, { version: string; digest: string }> = {
  terms: { version: "1.0", digest: "88593799cfad7f368c59c7f966577918ea008894fe438a7bed5820ee860f3594" },
  privacy: { version: "1.0", digest: "619f08eb8ad889c8cb8165c2d2e4f74c10bb30f1a5820ccf9c025d0d6f254c04" },
};

describe("bundled legal documents", () => {
  it("keeps each version and digest in step with the published rows", async () => {
    for (const document of LEGAL_DOCUMENTS) {
      expect(document.version, document.kind).toBe(PUBLISHED[document.kind].version);
      expect(await legalDocumentDigest(document), document.kind).toBe(PUBLISHED[document.kind].digest);
    }
  });

  it("publishes one document of each kind under a fixed id", () => {
    expect(LEGAL_DOCUMENTS.map((document) => document.kind).sort()).toEqual(["privacy", "terms"]);
    expect(new Set(Object.values(LEGAL_DOCUMENT_IDS)).size).toBe(2);
    for (const document of LEGAL_DOCUMENTS) {
      expect(currentLegalDocument(document.kind)).toBe(document);
      expect(document.title.length).toBeGreaterThan(0);
      expect(document.sections.length).toBeGreaterThan(0);
    }
  });

  it("does not claim counsel review the pilot documents have not had", () => {
    expect(LEGAL_REVIEW_NOTICE).toMatch(/reviewed/i);
    for (const document of LEGAL_DOCUMENTS) {
      expect(document.reviewStatus).toBe("counsel-review-required");
    }
  });
});

describe("requireLegalAcceptance", () => {
  it("rejects a registration that did not acknowledge the documents", async () => {
    await expect(requireLegalAcceptance(undefined)).rejects.toMatchObject({ status: 422, code: "validation_error" });
    await expect(requireLegalAcceptance({
      termsVersion: "1.0", privacyVersion: "1.0", termsAccepted: false, privacyAcknowledged: true,
    })).rejects.toMatchObject({ status: 422 });
    await expect(requireLegalAcceptance({
      termsVersion: "1.0", privacyVersion: "1.0", termsAccepted: true, privacyAcknowledged: false,
    })).rejects.toMatchObject({ status: 422 });
  });

  it("rejects a stale tab that accepted a version this release no longer publishes", async () => {
    await expect(requireLegalAcceptance({
      termsVersion: "0.9", privacyVersion: "1.0", termsAccepted: true, privacyAcknowledged: true,
    })).rejects.toMatchObject({ status: 422 });
    await expect(requireLegalAcceptance({
      termsVersion: "1.0", privacyVersion: "0.9", termsAccepted: true, privacyAcknowledged: true,
    })).rejects.toMatchObject({ status: 422 });
  });

  it("returns the accepted documents with their digests", async () => {
    const documents = await requireLegalAcceptance({
      termsVersion: "1.0", privacyVersion: "1.0", termsAccepted: true, privacyAcknowledged: true,
    });
    expect(documents.map((document) => document.kind)).toEqual(["terms", "privacy"]);
    for (const document of documents) {
      expect(document.digest).toBe(PUBLISHED[document.kind].digest);
      expect(document.id).toBe(LEGAL_DOCUMENT_IDS[document.kind]);
    }
  });
});
