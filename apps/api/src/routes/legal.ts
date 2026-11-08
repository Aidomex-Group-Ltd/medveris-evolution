import { Hono, type Context } from "hono";
import { legalAcceptanceSchema } from "@medveris/contracts";
import { withAnonymous } from "@medveris/db";
import { requireAuth, withActor } from "../auth/middleware.js";
import { writeAudit } from "../lib/audit.js";
import { DependencyError, ValidationError } from "../lib/errors.js";
import { requestAudit } from "../lib/actor.js";
import { parseJson, requestMeta } from "../lib/http.js";
import {
  LEGAL_REVIEW_NOTICE,
  currentLegalDocument,
  legalDocumentDigest,
  type LegalKind,
} from "../legal/documents.js";
import { legalAcceptanceStatus, recordLegalAcceptance, requireLegalAcceptance } from "../lib/legal.js";
import type { AppEnv } from "../types.js";

/**
 * Public legal pages and authenticated acceptance history.
 *
 * The page body is bundled with the release, while the published row in `legal_documents` is the
 * version/digest reference an acceptance points at. A visitor can read both without a session; only
 * the authenticated endpoints expose a person's own acknowledgement history.
 */
export const legalRoutes = new Hono<AppEnv>();

function kindParam(value: string): LegalKind {
  if (value !== "terms" && value !== "privacy") throw new ValidationError("Unknown legal document");
  return value;
}

async function publishedDigest(c: Context<AppEnv>, kind: LegalKind): Promise<string> {
  const document = currentLegalDocument(kind);
  const digest = await legalDocumentDigest(document);
  const [row] = await withAnonymous(c.get("deps").sql, (tx) => tx`
    select version, content_digest from legal_documents
     where kind = ${kind} and status = 'published'
     order by effective_at desc limit 1
  `);
  if (!row || String(row.version) !== document.version || String(row.contentDigest) !== digest) {
    throw new DependencyError("The published legal document does not match this release; it cannot be shown until the operator reconciles the version");
  }
  return digest;
}

legalRoutes.get("/public/legal", async (c) => {
  // Verify both published rows before advertising any version, so a partial migration cannot show
  // a Terms page whose digest differs from the records a registration would write.
  await publishedDigest(c, "terms");
  await publishedDigest(c, "privacy");
  const documents = ["terms", "privacy"].map((kind) => currentLegalDocument(kind as LegalKind));
  return c.json({
    documents: documents.map((document) => ({
      kind: document.kind,
      version: document.version,
      title: document.title,
      effectiveAt: document.effectiveAt,
      reviewStatus: document.reviewStatus,
      summary: document.summary,
      href: document.kind === "terms" ? "/terms" : "/privacy",
    })),
    reviewNotice: LEGAL_REVIEW_NOTICE,
  });
});

legalRoutes.get("/public/legal/:kind", async (c) => {
  const kind = kindParam(c.req.param("kind"));
  const digest = await publishedDigest(c, kind);
  const document = currentLegalDocument(kind);
  return c.json({
    ...document,
    digest,
    reviewNotice: LEGAL_REVIEW_NOTICE,
  });
});

legalRoutes.get("/me/legal", async (c) => {
  const auth = requireAuth(c);
  const status = await withActor(c, (tx) => legalAcceptanceStatus(tx, auth.user.id));
  return c.json({
    ...status,
    notice: "Accepting the Terms and acknowledging the Privacy Notice are separate from marketing, cookie and clinical consent.",
  });
});

/** Re-acceptance after a material change. Records are append-only; this never edits history. */
legalRoutes.post("/me/legal/accept", async (c) => {
  const auth = requireAuth(c);
  const deps = c.get("deps");
  const body = await parseJson(c, legalAcceptanceSchema);
  const documents = await requireLegalAcceptance(body);
  const meta = requestMeta(c);
  await withActor(c, async (tx) => {
    await recordLegalAcceptance(tx, deps.config.sessionSecret, {
      userId: auth.user.id,
      tenantId: auth.activeTenant?.id ?? null,
      context: "re-acceptance",
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    await writeAudit(tx, deps.config, requestAudit(c, "legal.acceptance", {
      resourceType: "LegalAcceptance",
      metadata: {
        context: "re-acceptance",
        documents: documents.map((document) => ({ kind: document.kind, version: document.version, digest: document.digest })),
      },
    }));
  });
  return c.json({
    ok: true,
    accepted: documents.map((document) => ({ kind: document.kind, version: document.version, digest: document.digest })),
  });
});
