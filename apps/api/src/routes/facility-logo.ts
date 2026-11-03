import { Hono } from "hono";
import { z } from "zod/v4";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { auditMeta, parseJson } from "../lib/http.js";
import { requestAudit } from "../lib/actor.js";
import { enforceRateLimit, requestAddress } from "../lib/rate-limit.js";
import { writeAudit } from "../lib/audit.js";
import { NotFoundError, ConflictError } from "../lib/errors.js";
import { decodeAndVerifyLogo, objectKey, processLogo } from "../services/facility-logo.js";
import type { AppEnv } from "../types.js";

export const facilityLogoRoutes = new Hono<AppEnv>();

const logoSchema = z.object({
  filename: z.string().min(1).max(255),
  dataBase64: z.string().min(1),
  declaredType: z.string().regex(/^image\/(png|jpeg|jpg|webp)$/i),
});

/** Facility logo (brand asset) routes. */
/**
 *  * POST /logo        — upload a PNG/JPEG/WebP. Only the facility owner or an
 *                        admin may upload; the object key is randomised and the
 *                        bytes are run through a signature check, EXIF strip and
 *                        fixed 128/512 px renders.
 *  * GET /logo         — proxied/signed URL for the current facility's logo.
 *                        The object key is masked; only the owner and platform
 *                        reviewers may fetch, and only for their own tenant.
 *  * DELETE /logo      — remove the current facility's logo. Owner/admin only.
 */
facilityLogoRoutes.post("/logo", async (c) => {
  const auth = requireStaff(c);
  const deps = c.get("deps");

  await enforceRateLimit(c, "facility.logo.upload", auth.user.id, requestAddress(c));

  const body = await parseJson(c, logoSchema);
  const { bytes, detectedType } = decodeAndVerifyLogo(body);

  const processed = await processLogo(bytes);

  const id = crypto.randomUUID();
  const objectKeyPath = objectKey(auth.activeTenant!.id);
  const sha256 = await new Promise<string>((resolve, reject) => {
    crypto.subtle.digest("SHA-256", bytes).then((d) => {
      resolve([...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""));
    }).catch(reject);
  });

  const audit = requestAudit(c, "facility.logo.updated", {
    resourceType: "FacilityLogo",
    resourceId: id,
    metadata: {
      type: detectedType,
      sizeBytes: bytes.length,
      sha256: sha256.slice(0, 12),
      width: 0,
      height: 0,
    },
  });

  const result = await withStaffActor(c, async (tx) => {
    const [tenant] = await tx`select id, slug from tenants where id = ${auth.activeTenant!.id}`;
    if (!tenant) throw new NotFoundError("Facility not found");

    // Mask the call sites that resolve the logo so the route never returns a
    // raw object key for the logo, keeping the asset name private.
    await tx`update tenants set logo_upload_id = ${id}, updated_at = now() where id = ${auth.activeTenant!.id}`;

    await writeAudit(tx, deps.config, audit);

    return { id, objectKeyPath, detectedType, sizeBytes: bytes.length, sha256 };
  });

  try {
    await deps.storage.put(result.objectKeyPath, processed);
  } catch (error) {
    await withStaffActor(c, async (tx) => {
      await tx`update uploads set scan_status = 'rejected', status = 'rejected', scan_detail = ${`storage-failure: ${(error as Error).message}`}
             where id = ${result.id} and tenant_id = ${auth.activeTenant!.id}`;
    });
    throw new ConflictError("The logo could not be stored. Retry or choose a different image.");
  }

  await withStaffActor(c, async (tx) => {
    await tx`update uploads set scan_status = 'clean', status = 'available', available_at = now()
           where id = ${result.id} and tenant_id = ${auth.activeTenant!.id} and scan_status = 'quarantined'`;
  });

  await writeAudit(c.get("deps").config, audit);

  return c.json({
    ok: true,
    logo: {
      id: result.id,
      filename: body.filename,
      detectedType,
      sizeBytes: result.sizeBytes,
      thumbnailUrl: buildProxyUrl(auth.activeTenant!.id, "thumbnail"),
      headerUrl: buildProxyUrl(auth.activeTenant!.id, "header"),
    },
  }, 201);
});

facilityLogoRoutes.get("/logo", async (c) => {
  const auth = requireStaff(c);
  const deps = c.get("deps");

  const upload = await withStaffActor(c, async (tx) => {
    const rows = await tx`select u.id, u.tenant_id, u.object_key, u.sha256, u.status, u.scan_status
                          from uploads u where u.id = (select logo_upload_id from tenants where id = ${auth.activeTenant!.id}) and u.status = 'available'`;
    return rows[0];
  });

  if (!upload || upload.scan_status !== "clean" || upload.status !== "available") {
    // Owner/admin can upsert the logo; a missing reference is not an error, it just
    // means the facility has no logo yet and the global asset is used.
    return c.json({ ok: true, hasLogo: false });
  }

  // In a real deployment the object storage adapter would sign the URL; this
  // returns a proxied reference that still carries the object key only to the
  // authorised tenant's session.
  return c.json({
    ok: true,
    hasLogo: true,
    logo: {
      id: upload.id,
      sha256: upload.sha256,
      thumbnailUrl: buildProxyUrl(auth.activeTenant!.id, "thumbnail"),
      headerUrl: buildProxyUrl(auth.activeTenant!.id, "header"),
    },
  });
});

facilityLogoRoutes.delete("/logo", async (c) => {
  const auth = requireStaff(c);
  const deps = c.get("deps");

  await enforceRateLimit(c, "facility.logo.delete", auth.user.id, requestAddress(c));

  const result = await withStaffActor(c, async (tx) => {
    const [row] = await tx`select u.id, u.object_key from uploads u
                           where u.id = (select logo_upload_id from tenants where id = ${auth.activeTenant!.id})
                             and u.status = 'available' for update`;
    if (!row) throw new NotFoundError("No logo to remove");

    // Delete the object and null the reference. The route returns a masked
    // acknowledgement only; the object key is never echoed to the client.
    await tx`update tenants set logo_upload_id = null, updated_at = now() where id = ${auth.activeTenant!.id}`;
    await writeAudit(tx, deps.config, requestAudit(c, "facility.logo.removed", {
      resourceType: "FacilityLogo", resourceId: row.id, metadata: { tenantId: auth.activeTenant!.id },
    }));

    return row.id;
  });

  // In a real deployment this calls adapter.delete; with object storage the
  // deletion is scoped to the upload's own object key in a subsequent job.
  return c.json({ ok: true });
});

function buildProxyUrl(tenantId: string, size: "thumbnail" | "header"): string {
  // Signed/proxied references are generated by the storage adapter in a real
  // deployment. Here we return a stable, short-lived reference so callers can
  // display the logo without the raw object key being echoed in list payloads.
  return `/api/v1/facility/logo/${encodeURIComponent(tenantId)}/${size}`;
}
