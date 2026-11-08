import { hmacHex } from "@medveris/auth";
import type { Tx } from "@medveris/db";
import {
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_IDS,
  LEGAL_REVIEW_NOTICE,
  currentLegalDocument,
  legalDocumentDigest,
  type LegalDocument,
  type LegalKind,
} from "../legal/documents.js";
import { ValidationError } from "./errors.js";

export interface LegalAcceptanceInput {
  termsVersion: string;
  privacyVersion: string;
  termsAccepted: boolean;
  privacyAcknowledged: boolean;
}

export interface CurrentLegalDocument extends LegalDocument {
  id: string;
  digest: string;
}

/** The versions bundled with this release, with the digest an acceptance record must carry. */
export async function currentLegalDocuments(): Promise<CurrentLegalDocument[]> {
  return Promise.all(LEGAL_DOCUMENTS.map(async (document) => ({
    ...document,
    id: LEGAL_DOCUMENT_IDS[document.kind],
    digest: await legalDocumentDigest(document),
  })));
}

/**
 * Validates the registration/re-acceptance acknowledgement. Viewing a page is not acceptance: both
 * booleans must be explicitly true and the client must name the versions it displayed, so a stale
 * tab cannot accept a version it never showed.
 */
export async function requireLegalAcceptance(input: LegalAcceptanceInput | null | undefined): Promise<CurrentLegalDocument[]> {
  const documents = await currentLegalDocuments();
  const terms = documents.find((document) => document.kind === "terms")!;
  const privacy = documents.find((document) => document.kind === "privacy")!;
  const details: Array<{ path: string; message: string }> = [];
  if (!input) {
    details.push({ path: "legal", message: "Accept the Terms of Service and acknowledge the Privacy Notice to continue" });
  } else {
    if (input.termsAccepted !== true || input.termsVersion !== terms.version) {
      details.push({ path: "legal.termsAccepted", message: `Accept Terms of Service version ${terms.version}` });
    }
    if (input.privacyAcknowledged !== true || input.privacyVersion !== privacy.version) {
      details.push({ path: "legal.privacyAcknowledged", message: `Acknowledge Privacy Notice version ${privacy.version}` });
    }
  }
  if (details.length) {
    throw new ValidationError("Accept the Terms of Service and acknowledge the Privacy Notice to continue", details);
  }
  return [terms, privacy];
}

export interface LegalAcceptanceActor {
  userId: string;
  tenantId?: string | null;
  context: "registration" | "re-acceptance" | "invitation";
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Appends the acknowledgement records inside the caller's transaction. The unique key is the exact
 * document id, so re-submitting the same version is idempotent and a new version always creates a
 * new record rather than overwriting history.
 *
 * The already-accepted check is an explicit select rather than `on conflict do nothing`: the
 * registration actor may only append, so the conflict check's read of the existing row would be
 * rejected by row-level security. A brand-new account has no earlier acceptance, and a re-acceptance
 * runs with the user's own read policy, so the check covers both paths without widening the policy.
 */
export async function recordLegalAcceptance(tx: Tx, sessionSecret: string, actor: LegalAcceptanceActor): Promise<void> {
  const documents = await currentLegalDocuments();
  const accepted = await tx`
    select document_id from legal_acceptances where user_id = ${actor.userId}
  `;
  const acceptedIds = new Set(accepted.map((row) => String(row.documentId)));
  const missing = documents.filter((document) => !acceptedIds.has(document.id));
  if (!missing.length) return;
  const ipHash = actor.ipAddress
    ? await hmacHex(sessionSecret, `legal-acceptance:ip:${actor.ipAddress.trim().toLowerCase()}`)
    : null;
  const userAgentDigest = actor.userAgent
    ? await hmacHex(sessionSecret, `legal-acceptance:ua:${actor.userAgent.trim()}`)
    : null;
  for (const document of missing) {
    await tx`
      insert into legal_acceptances (
        id, user_id, tenant_id, document_id, policy_kind, policy_version, policy_digest,
        context, accepted_at, ip_hash, user_agent_digest
      ) values (
        ${crypto.randomUUID()}, ${actor.userId}, ${actor.tenantId ?? null}, ${document.id}, ${document.kind},
        ${document.version}, ${document.digest}, ${actor.context}, now(), ${ipHash}, ${userAgentDigest}
      )
    `;
  }
}

export interface LegalAcceptanceStatus {
  current: Array<{ kind: LegalKind; version: string; title: string; effectiveAt: string; digest: string; accepted: boolean; acceptedAt: string | null }>;
  requiresAcceptance: boolean;
  reviewNotice: string;
}

/** What this user has accepted among the versions currently bundled with the release. */
export async function legalAcceptanceStatus(tx: Tx, userId: string): Promise<LegalAcceptanceStatus> {
  const documents = await currentLegalDocuments();
  const rows = await tx`
    select document_id, accepted_at from legal_acceptances where user_id = ${userId}
  `;
  const accepted = new Map(rows.map((row) => [String(row.documentId), new Date(row.acceptedAt as Date).toISOString()]));
  const current = documents.map((document) => ({
    kind: document.kind,
    version: document.version,
    title: document.title,
    effectiveAt: document.effectiveAt,
    digest: document.digest,
    accepted: accepted.has(document.id),
    acceptedAt: accepted.get(document.id) ?? null,
  }));
  return {
    current,
    requiresAcceptance: current.some((document) => !document.accepted),
    reviewNotice: LEGAL_REVIEW_NOTICE,
  };
}

/** A published row is only usable when it matches this release's bundled version and digest. */
export async function assertPublishedDocumentsMatch(tx: Tx): Promise<void> {
  const documents = await currentLegalDocuments();
  const rows = await tx`
    select kind, version, content_digest from legal_documents where status = 'published'
  `;
  for (const document of documents) {
    const row = rows.find((candidate) => String(candidate.kind) === document.kind);
    if (!row || String(row.version) !== document.version || String(row.contentDigest) !== document.digest) {
      throw new Error(`The published ${document.kind} document does not match the bundled version ${document.version}`);
    }
  }
}

export { currentLegalDocument };
