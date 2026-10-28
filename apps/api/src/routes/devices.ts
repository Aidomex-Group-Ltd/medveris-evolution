import { Hono } from "hono";
import {
  alertAcknowledgementSchema,
  deviceAssignmentSchema,
  deviceObservationSchema,
  deviceSchema,
  uuidSchema,
} from "@medveris/contracts";
import { assertWardAccess, assertWardView, assertMembershipAdmin } from "@medveris/authz";
import { requireStaff, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { parseJson } from "../lib/http.js";
import { writeAudit } from "../lib/audit.js";
import { enforceRateLimit } from "../lib/rate-limit.js";
import { ConflictError, ForbiddenError, ValidationError } from "../lib/errors.js";
import { assertIntegrationAvailable } from "../integrations/registry.js";
import type { AppEnv } from "../types.js";

export const deviceRoutes = new Hono<AppEnv>();

function hasRole(c: Parameters<typeof requireStaff>[0], ...roles: string[]): boolean {
  return requestActor(c).roles.some((role) => roles.includes(role));
}

deviceRoutes.get("/devices", async (c) => {
  requireStaff(c);
  assertWardView(requestActor(c));
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select d.*, (select row_to_json(da) from device_assignments da where da.device_id = d.id and da.released_at is null limit 1) as active_assignment
      from devices d where d.tenant_id = ${auth.activeTenant!.id} order by d.manufacturer, d.model, d.serial
  `);
  return c.json({ devices: rows });
});

deviceRoutes.post("/devices", async (c) => {
  requireStaff(c);
  assertMembershipAdmin(requestActor(c));
  if (!hasRole(c, "clinician", "nurse", "facility_admin")) throw new ForbiddenError("Clinical or administrator permission is required");
  const auth = c.get("auth")!;
  const body = await parseJson(c, deviceSchema);
  const id = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    await tx`
      insert into devices (id, tenant_id, serial, manufacturer, model, firmware, site, created_by)
      values (${id}, ${auth.activeTenant!.id}, ${body.serial}, ${body.manufacturer}, ${body.model}, ${body.firmware || null}, ${body.site || null}, ${auth.user.id})
    `;
    for (const metric of body.supportedMetrics) {
      await tx`
        insert into device_metric_capabilities (id, tenant_id, device_id, native_code, loinc_system, loinc_version, loinc_code, display, unit_code)
        values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${metric.nativeCode}, ${metric.loincSystem},
          ${metric.loincVersion}, ${metric.loincCode}, ${metric.display}, ${metric.unitCode})
      `;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "device.register", {
      resourceType: "Device", resourceId: id,
      metadata: { serial: body.serial, metrics: body.supportedMetrics.length },
    }));
  });
  return c.json({ ok: true, device: { id } }, 201);
});

deviceRoutes.post("/devices/:id/assign", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  if (!hasRole(c, "clinician", "nurse")) throw new ForbiddenError("Clinical or nursing permission is required to assign a device");
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, deviceAssignmentSchema);
  await withStaffActor(c, async (tx) => {
    const device = await requireRows(await tx`
      select id, status from devices where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Device not found");
    if (device.status !== "active") throw new ConflictError("Only active devices can be assigned");
    const encounter = await tx`select 1 from encounters where id = ${body.encounterId} and patient_id = ${body.patientId} and tenant_id = ${auth.activeTenant!.id}`;
    if (!encounter[0]) throw new ValidationError("The encounter does not belong to the selected patient");
    const active = await tx`select id from device_assignments where device_id = ${id} and released_at is null`;
    if (active[0]) throw new ConflictError("The device is already assigned; release the existing assignment first");
    await tx`
      insert into device_assignments (id, tenant_id, device_id, patient_id, encounter_id, assigned_by)
      values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${id}, ${body.patientId}, ${body.encounterId}, ${auth.user.id})
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "device.assign", {
      subjectPatientId: body.patientId, resourceType: "Device", resourceId: id,
      metadata: { encounterId: body.encounterId },
    }));
  });
  return c.json({ ok: true });
});

deviceRoutes.post("/devices/:id/ingest", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  assertIntegrationAvailable(c.get("deps").config, "devices", "devices.ingest", "no observation was stored");
  await enforceRateLimit(c, "device.ingest", c.get("auth")!.user.id);
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, deviceObservationSchema);
  const observationId = crypto.randomUUID();
  await withStaffActor(c, async (tx) => {
    const device = await requireRows(await tx`
      select id, status from devices where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update
    `, "Device not found");
    if (device.status !== "active") throw new ConflictError("Only active devices can send observations");
    const capability = await tx`
      select * from device_metric_capabilities where device_id = ${id} and native_code = ${body.nativeCode} and tenant_id = ${auth.activeTenant!.id}
    `;
    const mapped = await requireRows(capability, "The native metric code is not mapped for this device");
    if (String(mapped.unitCode) !== body.unit) throw new ValidationError("The submitted unit does not match the reviewed device mapping");
    const assignment = await requireRows(await tx`
      select id, patient_id, encounter_id from device_assignments
       where device_id = ${id} and tenant_id = ${auth.activeTenant!.id} and released_at is null for update
    `, "The device is not assigned to a patient");
    const duplicate = await tx`select 1 from device_observations where tenant_id = ${auth.activeTenant!.id} and device_id = ${id} and event_id = ${body.eventId}`;
    if (duplicate[0]) throw new ConflictError("This device event has already been ingested");
    const coding = {
      system: mapped.loincSystem, version: mapped.loincVersion, code: mapped.loincCode,
      display: mapped.display, text: mapped.display, userSelected: false,
    };
    await tx`
      insert into observations (id, tenant_id, patient_id, encounter_id, loinc_system, loinc_version, loinc_code, display,
        original_text, coding, value_num, unit_code, unit_system, occurred_at, recorded_at, author_id, status, note)
      values (${observationId}, ${auth.activeTenant!.id}, ${assignment.patientId}, ${assignment.encounterId},
        ${mapped.loincSystem}, ${mapped.loincVersion}, ${mapped.loincCode}, ${mapped.display}, ${body.nativeCode},
        ${tx.json(coding as never)}, ${body.value}, ${body.unit}, 'http://unitsofmeasure.org', ${new Date(body.measuredAt)},
        ${new Date()}, ${auth.user.id}, 'final', ${`Device ${id} event ${body.eventId}; quality ${body.quality}`})
    `;
    const deviceObservationId = crypto.randomUUID();
    await tx`
      insert into device_observations (id, tenant_id, device_id, assignment_id, patient_id, encounter_id, event_id, sequence,
        native_code, loinc_system, loinc_version, loinc_code, display, value_num, unit_code, measured_at, quality, observation_id)
      values (${deviceObservationId}, ${auth.activeTenant!.id}, ${id}, ${assignment.id}, ${assignment.patientId}, ${assignment.encounterId},
        ${body.eventId}, ${body.sequence}, ${body.nativeCode}, ${mapped.loincSystem}, ${mapped.loincVersion}, ${mapped.loincCode},
        ${mapped.display}, ${body.value}, ${body.unit}, ${new Date(body.measuredAt)}, ${body.quality}, ${observationId})
    `;
    await tx`update devices set last_seen_at = now() where id = ${id}`;
    if (body.quality !== "valid") {
      await tx`
        insert into device_alerts (id, tenant_id, device_observation_id, severity, message)
        values (${crypto.randomUUID()}, ${auth.activeTenant!.id}, ${deviceObservationId}, 'warning',
          ${`Device reading failed quality validation (${body.quality})`})
      `;
    }
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "device.observation.ingest", {
      subjectPatientId: String(assignment.patientId), resourceType: "DeviceObservation", resourceId: deviceObservationId,
      metadata: { deviceId: id, nativeCode: body.nativeCode, loincCode: mapped.loincCode, quality: body.quality, observationId },
    }));
  });
  return c.json({ ok: true, observation: { id: observationId } }, 201);
});

deviceRoutes.get("/devices/:id/observations", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const rows = await withStaffActor(c, async (tx) => tx`
    select devobs.*, p.public_id from device_observations devobs join patients p on p.id = devobs.patient_id
     where devobs.device_id = ${id} and devobs.tenant_id = ${auth.activeTenant!.id}
     order by devobs.measured_at desc limit 500
  `);
  return c.json({ observations: rows });
});

deviceRoutes.get("/device-alerts", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const rows = await withStaffActor(c, async (tx) => tx`
    select da.*, devobs.measured_at, devobs.native_code, devobs.value_num, devobs.unit_code, p.public_id, p.given_name, p.family_name,
           d.serial, d.manufacturer, d.model
      from device_alerts da join device_observations devobs on devobs.id = da.device_observation_id
      join patients p on p.id = devobs.patient_id join devices d on d.id = devobs.device_id
     where da.tenant_id = ${auth.activeTenant!.id} and da.status = 'active'
     order by da.created_at desc
  `);
  return c.json({ alerts: rows });
});

deviceRoutes.post("/device-alerts/:id/acknowledge", async (c) => {
  requireStaff(c);
  assertWardAccess(requestActor(c));
  const auth = c.get("auth")!;
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, alertAcknowledgementSchema);
  await withStaffActor(c, async (tx) => {
    const alert = await requireRows(await tx`
      select da.id, devobs.patient_id from device_alerts da join device_observations devobs on devobs.id = da.device_observation_id
       where da.id = ${id} and da.tenant_id = ${auth.activeTenant!.id} and da.status = 'active' for update
    `, "Active device alert not found");
    await tx`
      update device_alerts set status = 'acknowledged', acknowledged_by = ${auth.user.id},
        acknowledged_at = now(), acknowledgement_note = ${body.note || null} where id = ${id}
    `;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "device.alert.acknowledge", {
      subjectPatientId: String(alert.patientId), resourceType: "DeviceAlert", resourceId: id,
    }));
  });
  return c.json({ ok: true });
});
