import { Hono } from "hono";
import { z } from "zod/v4";
import { canManageTenant } from "@medveris/authz";
import { requestActor } from "../lib/actor.js";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { parseJson } from "../lib/http.js";
import { requestAudit } from "../lib/actor.js";
import { enforceRateLimit, requestAddress } from "../lib/rate-limit.js";
import { writeAudit } from "../lib/audit.js";
import { DependencyError, NotFoundError, ForbiddenError } from "../lib/errors.js";
import { decodeAndVerifyLogo, objectKey, sanitizeImage, extensionFor } from "../services/facility-logo.js";
import type { AppEnv } from "../types.js";

export const facilityLogoRoutes = new Hono<AppEnv>();

const logoSchema = z.object({
  filename: z.string().min(1).max(255),
  dataBase64: z.string().min(1).max(3 * 1024 * 1024),
  declaredType: z.string().regex(/^image\/(png|jpeg|webp)$/i),
});

/** Facility logo (brand asset) routes. Logos are metadata-stripped on upload and served tenant-scoped. */
facilityLogoRoutes.post("/logo", async (c) => {
  const auth = requireStaff(c);
  const deps = c.get("deps");
  if (!canManageTenant(requestActor(c))) {
    throw new ForbiddenError("Only facility administrators may change the facility logo");
  }

  await enforceRateLimit(c, "upload", auth.user.id, requestAddress(c));

  const body = await parseJson(c, logoSchema);
  const { bytes, detectedType } = decodeAndVerifyLogo(body);
  const sanitized = sanitizeImage(bytes, detectedType);

  const id = crypto.randomUUID();
  const objectKeyPath = objectKey(auth.activeTenant!.id, detectedType);
  const digest = await crypto.subtle.digest("SHA-256", sanitized.buffer as ArrayBuffer);
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

  try {
    await deps.storage.put(objectKeyPath, sanitized);
  } catch {
    throw new DependencyError("The logo could not be stored. Retry or choose a different image.");
  }

  await withStaffActor(c, async (tx) => {
    const [tenant] = await tx`select id from tenants where id = ${auth.activeTenant!.id}`;
    if (!tenant) throw new NotFoundError("Facility not found");
    await tx`
      insert into uploads (id, tenant_id, owner_user_id, filename, declared_type, detected_type, size_bytes, sha256, object_key, scan_status, status, scan_detail, available_at)
      values (${id}, ${auth.activeTenant!.id}, ${auth.user.id}, ${body.filename}, ${detectedType}, ${detectedType}, ${sanitized.length}, ${sha256}, ${objectKeyPath}, 'clean', 'available', 'Signature verified and privacy metadata stripped. This is not a malware scan.', now())
    `;
    await tx`update tenants set logo_upload_id = ${id}, updated_at = now() where id = ${auth.activeTenant!.id}`;
    await writeAudit(tx, deps.config, requestAudit(c, "facility.logo.updated", {
      resourceType: "FacilityLogo",
      resourceId: id,
      metadata: {
        type: detectedType,
        sizeBytes: sanitized.length,
        sha256: sha256.slice(0, 12),
      },
    }));
  });

  return c.json({
    ok: true,
    logo: { id, detectedType, sizeBytes: sanitized.length, sha256, contentUrl: "/api/v1/facility/logo/content" },
  }, 201);
});

facilityLogoRoutes.get("/logo", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;

  const upload = await withStaffActor(c, async (tx) => {
    const rows = await tx`select u.id, u.sha256, u.detected_type, u.size_bytes
                          from uploads u where u.id = (select logo_upload_id from tenants where id = ${auth.activeTenant!.id})
                            and u.status = 'available' and u.scan_status = 'clean'`;
    return rows[0];
  });

  if (!upload) {
    return c.json({ ok: true, hasLogo: false });
  }

  return c.json({
    ok: true,
    hasLogo: true,
    logo: {
      id: upload.id,
      sha256: upload.sha256,
      detectedType: upload.detectedType,
      sizeBytes: upload.sizeBytes,
      contentUrl: "/api/v1/facility/logo/content",
    },
  });
});

facilityLogoRoutes.get("/logo/content", async (c) => {
  requireStaff(c);
  const auth = c.get("auth")!;
  const deps = c.get("deps");

  const upload = await withStaffActor(c, async (tx) => {
    const rows = await tx`select u.id, u.object_key, u.detected_type, u.filename
                          from uploads u where u.id = (select logo_upload_id from tenants where id = ${auth.activeTenant!.id})
                            and u.status = 'available' and u.scan_status = 'clean'`;
    return rows[0];
  });
  if (!upload) throw new NotFoundError("No logo is set for this facility");

  const bytes = await deps.storage.get(String(upload.objectKey));
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "content-type": String(upload.detectedType ?? "application/octet-stream"),
      "content-disposition": `inline; filename="logo.${extensionFor(String(upload.detectedType ?? "image/png"))}"`,
      "cache-control": "private, no-store",
    },
  });
});

facilityLogoRoutes.delete("/logo", async (c) => {
  const auth = requireStaff(c);
  const deps = c.get("deps");
  if (!canManageTenant(requestActor(c))) {
    throw new ForbiddenError("Only facility administrators may remove the facility logo");
  }

  await enforceRateLimit(c, "upload", auth.user.id, requestAddress(c));

  const removed = await withStaffActor(c, async (tx) => {
    const rows = await tx`select u.id, u.object_key from uploads u
                           where u.id = (select logo_upload_id from tenants where id = ${auth.activeTenant!.id})
                             and u.status = 'available' for update`;
    const row = rows[0];
    if (!row) throw new NotFoundError("No logo to remove");
    await tx`update tenants set logo_upload_id = null, updated_at = now() where id = ${auth.activeTenant!.id}`;
    await tx`update uploads set status = 'rejected', scan_detail = 'Removed by facility administrator' where id = ${row.id}`;
    await writeAudit(tx, deps.config, requestAudit(c, "facility.logo.removed", {
      resourceType: "FacilityLogo", resourceId: row.id, metadata: { tenantId: auth.activeTenant!.id },
    }));
    return row;
  });

  try {
    await deps.storage.delete(String(removed.objectKey));
  } catch {
    // The object may already be gone or storage may be unconfigured; the reference is removed either way.
  }

  return c.json({ ok: true });
});
