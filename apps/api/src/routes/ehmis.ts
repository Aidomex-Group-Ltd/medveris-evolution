import { Hono, type Context } from "hono";
import {
  hmisCredentialsSchema,
  hmisEligibilityDecisionSchema,
  hmisEligibilityRequestSchema,
  hmisLiveSubmissionSchema,
  hmisManualSubmissionSchema,
  hmisMappingApproveSchema,
  hmisMappingSchema,
  hmisPeriodApproveSchema,
  hmisPeriodGenerateSchema,
  hmisPeriodReopenSchema,
  hmisReportingRuleSchema,
  hmisSettingsSchema,
  uuidSchema,
} from "@medveris/contracts";
import { permissionsForRoles, type Permission } from "@medveris/authz";
import { withContext, type Tx } from "@medveris/db";
import { HMIS_AGE_BANDS, HMIS_METRICS, type PeriodType } from "@medveris/domain";
import { isPlatformOperator, requireStaff, withPlatformActor, withStaffActor } from "../auth/middleware.js";
import { requestActor, requestAudit, requireRows } from "../lib/actor.js";
import { writeAudit } from "../lib/audit.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { ensureMatch, parseJson } from "../lib/http.js";
import { enforceRateLimit } from "../lib/rate-limit.js";
import { Dhis2Client, Dhis2Error, baseUrlProblems, type DataValueSet } from "../integrations/dhis2.js";
import { IntegrationUnavailableError, integrationStatus } from "../integrations/registry.js";
import {
  computeValues,
  connectionFingerprint,
  credentialHint,
  dataValueSet,
  decryptCredentials,
  dhis2Csv,
  effectiveRule,
  encryptCredentials,
  idempotencyKey,
  liveReadiness,
  loadIntegration,
  payloadDigest,
  periodDates,
  publicIntegration,
  schedule,
  validate,
  type ComputedValue,
  type MappingElement,
  type ValidationIssue,
} from "../services/ehmis.js";
import type { AppEnv } from "../types.js";

/**
 * Facility-scoped eHMIS / DHIS2 aggregate reporting. Preparing, validating, approving and exporting HMIS
 * periods always works; live submission additionally needs deployment authorization, platform-verified
 * facility eligibility and a passing connection test. Nothing here submits client-level data.
 */
export const ehmisRoutes = new Hono<AppEnv>();

const STALE_SUBMISSION_MS = 10 * 60_000;

type C = Context<AppEnv>;

function can(c: C, permission: Permission): boolean {
  return permissionsForRoles(requestActor(c).roles).has(permission);
}

function requirePermission(c: C, permission: Permission): void {
  if (!can(c, permission)) throw new ForbiddenError("eHMIS reporting requires a facility administrator or public-health officer");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function ledger(tx: Tx, input: {
  tenantId: string; periodId?: string | null; kind: string; outcome: string; idempotencyKey?: string | null; requestDigest?: string | null;
  httpStatus?: number | null; summary?: Record<string, unknown>; error?: string | null; actorUserId: string; startedAt: Date;
}): Promise<void> {
  await tx`
    insert into hmis_submission_ledger (id, tenant_id, period_id, kind, idempotency_key, request_digest, outcome, http_status, summary, error, actor_user_id, started_at)
    values (${crypto.randomUUID()}, ${input.tenantId}, ${input.periodId ?? null}, ${input.kind}, ${input.idempotencyKey ?? null}, ${input.requestDigest ?? null},
      ${input.outcome}, ${input.httpStatus ?? null}, ${tx.json((input.summary ?? {}) as never)}, ${input.error ?? null}, ${input.actorUserId}, ${input.startedAt})`;
}

async function upsertIntegration(tx: Tx, tenantId: string, userId: string): Promise<void> {
  await tx`insert into hmis_integrations (tenant_id, updated_by) values (${tenantId}, ${userId}) on conflict (tenant_id) do nothing`;
}

function failureMessage(error: unknown): string {
  if (error instanceof Dhis2Error) return `${error.failure}: ${error.message}`;
  return error instanceof Error ? error.message.slice(0, 300) : "unexpected failure";
}

async function clientFor(c: C, row: Record<string, unknown>): Promise<Dhis2Client> {
  const deps = c.get("deps");
  const tenantId = c.get("auth")!.activeTenant!.id;
  const credentials = await decryptCredentials(deps.config, tenantId, String(row.credentialCiphertext));
  return new Dhis2Client(String(row.dhis2BaseUrl), credentials, deps.config.ehmis.timeoutMs, deps.dhis2Transport);
}

// ---------------------------------------------------------------- overview and setup

ehmisRoutes.get("/ehmis", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "hmis.report.prepare");
  const tenantId = auth.activeTenant!.id;
  const config = c.get("deps").config;
  const now = today();
  const data = await withStaffActor(c, async (tx) => {
    const integration = await loadIntegration(tx, tenantId);
    const mappings = await tx`
      select m.id, m.dataset_code, m.dataset_name, m.dhis2_data_set_uid, m.period_type, m.attribute_option_combo_uid, m.elements, m.status,
             m.approval_reference, m.approved_at, m.version, m.created_at, u.display_name as approved_by_name
        from hmis_dataset_mappings m left join users u on u.id = m.approved_by
       where m.tenant_id = ${tenantId} and m.status <> 'retired' order by m.created_at`;
    const periods = await tx`
      select p.id, p.mapping_id, p.period, to_char(p.period_start, 'YYYY-MM-DD') as period_start, to_char(p.period_end, 'YYYY-MM-DD') as period_end,
             p.revision, p.status, p.data_values, p.validation, p.content_digest, p.idempotency_key, p.generated_at, p.approved_at, p.submitted_at,
             p.import_summary, p.last_error, p.attempt_count, p.manual_reference, p.version, m.dataset_code, m.period_type,
             g.display_name as generated_by_name, a.display_name as approved_by_name
        from hmis_report_periods p join hmis_dataset_mappings m on m.id = p.mapping_id
        join users g on g.id = p.generated_by left join users a on a.id = p.approved_by
       where p.tenant_id = ${tenantId} and p.status <> 'superseded'
       order by p.period_start desc, m.dataset_code limit 60`;
    const entries = await tx`
      select l.kind, l.outcome, l.http_status, l.summary, l.error, l.idempotency_key, l.started_at, l.finished_at, u.display_name as actor_name, p.period
        from hmis_submission_ledger l left join users u on u.id = l.actor_user_id left join hmis_report_periods p on p.id = l.period_id
       where l.tenant_id = ${tenantId} order by l.finished_at desc, l.started_at desc limit 100`;
    const rules: Record<string, unknown> = {};
    for (const type of ["Monthly", "Weekly", "Quarterly"] as const) rules[type] = await effectiveRule(tx, tenantId, type);
    const withSchedule = periods.map((period) => {
      const rule = rules[String(period.periodType)] as Awaited<ReturnType<typeof effectiveRule>>;
      return { ...period, schedule: schedule(periodDates(String(period.period), period.periodType as PeriodType), rule, now) };
    });
    return { integration, mappings, periods: withSchedule, ledger: entries, rules };
  });
  return c.json({
    integration: publicIntegration(data.integration),
    deployment: integrationStatus(config, "ehmis"),
    readiness: await liveReadiness(config, data.integration, now),
    baseUrlProblems: baseUrlProblems((data.integration.dhis2BaseUrl as string | null) ?? null, config.ehmis, config.appEnv),
    credentialStorageAvailable: Boolean(config.ehmis.credentialsKey),
    mappings: data.mappings,
    periods: data.periods,
    ledger: data.ledger,
    rules: data.rules,
    metrics: HMIS_METRICS,
    ageBands: HMIS_AGE_BANDS,
    notices: [
      "Medveris does not claim Ministry of Health certification. Live reporting is enabled only for facilities whose eligibility and authorization were verified.",
      "Only routine aggregate HMIS reporting is supported. Client-level reporting requires a separate, exceptional Ministry authorization and is not available.",
      "Map only datasets and data elements approved for this facility; confirm UIDs and category option combos with the district biostatistician.",
    ],
    permissions: { manage: can(c, "hmis.integration.manage"), prepare: can(c, "hmis.report.prepare"), submit: can(c, "hmis.report.submit") },
  });
});

ehmisRoutes.put("/ehmis/settings", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "hmis.integration.manage");
  const body = await parseJson(c, hmisSettingsSchema);
  const tenantId = auth.activeTenant!.id;
  await withStaffActor(c, async (tx) => {
    await upsertIntegration(tx, tenantId, auth.user.id);
    const current = await loadIntegration(tx, tenantId);
    const connectionChanged = (body.dhis2BaseUrl ?? null) !== (current.dhis2BaseUrl ?? null) || (body.dhis2OrgUnitUid ?? null) !== (current.dhis2OrgUnitUid ?? null);
    await tx`
      update hmis_integrations set nhfr_id = ${body.nhfrId ?? null}, dhis2_base_url = ${body.dhis2BaseUrl?.replace(/\/+$/, "") ?? null},
        dhis2_org_unit_uid = ${body.dhis2OrgUnitUid ?? null},
        connection_status = ${connectionChanged ? "not-tested" : String(current.connectionStatus)},
        dhis2_org_unit_name = ${connectionChanged ? null : (current.dhis2OrgUnitName as string | null) ?? null},
        live_submission_enabled = ${connectionChanged ? false : Boolean(current.liveSubmissionEnabled)},
        updated_by = ${auth.user.id}, updated_at = now()
       where tenant_id = ${tenantId}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "ehmis.settings.update", {
      resourceType: "HmisIntegration", resourceId: tenantId, metadata: { connectionChanged, orgUnit: body.dhis2OrgUnitUid ?? null },
    }));
  });
  return c.json({ ok: true });
});

ehmisRoutes.post("/ehmis/eligibility-request", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "hmis.integration.manage");
  const body = await parseJson(c, hmisEligibilityRequestSchema);
  const tenantId = auth.activeTenant!.id;
  await withStaffActor(c, async (tx) => {
    await upsertIntegration(tx, tenantId, auth.user.id);
    await tx`
      update hmis_integrations set authorization_reference = ${body.authorizationReference}, authorization_issuer = ${body.authorizationIssuer},
        authorization_valid_until = ${body.authorizationValidUntil || null}, authorization_scope = 'aggregate',
        eligibility_status = 'pending-verification', eligibility_requested_by = ${auth.user.id}, eligibility_requested_at = now(),
        eligibility_decided_by = null, eligibility_decided_at = null, eligibility_decision_note = null, live_submission_enabled = false,
        updated_by = ${auth.user.id}, updated_at = now()
       where tenant_id = ${tenantId}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "ehmis.eligibility.request", {
      resourceType: "HmisIntegration", resourceId: tenantId, metadata: { issuer: body.authorizationIssuer, validUntil: body.authorizationValidUntil || null },
    }));
  });
  return c.json({ ok: true, eligibilityStatus: "pending-verification" });
});

ehmisRoutes.post("/ehmis/credentials", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "hmis.integration.manage");
  const config = c.get("deps").config;
  if (!config.ehmis.credentialsKey) {
    throw new AppError(503, "credential_storage_unavailable", "Credential storage is not configured for this deployment (EHMIS_CREDENTIALS_KEY); nothing was stored");
  }
  const body = await parseJson(c, hmisCredentialsSchema);
  const tenantId = auth.activeTenant!.id;
  const ciphertext = await encryptCredentials(config, tenantId, body);
  await withStaffActor(c, async (tx) => {
    await upsertIntegration(tx, tenantId, auth.user.id);
    await tx`
      update hmis_integrations set credential_kind = ${body.kind}, credential_ciphertext = ${ciphertext}, credential_hint = ${credentialHint(body)},
        credential_set_by = ${auth.user.id}, credential_set_at = now(), connection_status = 'not-tested', live_submission_enabled = false,
        updated_by = ${auth.user.id}, updated_at = now()
       where tenant_id = ${tenantId}`;
    await writeAudit(tx, config, requestAudit(c, "ehmis.credentials.set", { resourceType: "HmisIntegration", resourceId: tenantId, metadata: { kind: body.kind } }));
  });
  return c.json({ ok: true, hint: credentialHint(body) });
});

ehmisRoutes.delete("/ehmis/credentials", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "hmis.integration.manage");
  const tenantId = auth.activeTenant!.id;
  await withStaffActor(c, async (tx) => {
    await tx`
      update hmis_integrations set credential_kind = null, credential_ciphertext = null, credential_hint = null, credential_set_by = ${auth.user.id},
        credential_set_at = now(), connection_status = 'not-tested', live_submission_enabled = false, updated_at = now()
       where tenant_id = ${tenantId}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "ehmis.credentials.remove", { resourceType: "HmisIntegration", resourceId: tenantId }));
  });
  return c.json({ ok: true });
});

ehmisRoutes.post("/ehmis/connection-test", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "hmis.integration.manage");
  await enforceRateLimit(c, "integration.request", auth.user.id);
  const config = c.get("deps").config;
  const tenantId = auth.activeTenant!.id;
  const environment = integrationStatus(config, "ehmis");
  if (environment.state !== "available") throw new IntegrationUnavailableError(environment, "ehmis.connection-test", "no connection was attempted");
  const row = await withStaffActor(c, async (tx) => loadIntegration(tx, tenantId));
  const problems = [...baseUrlProblems((row.dhis2BaseUrl as string | null) ?? null, config.ehmis, config.appEnv)];
  if (!row.credentialKind) problems.push("Store the facility's DHIS2 credentials first");
  if (!row.dhis2OrgUnitUid) problems.push("Map the facility's DHIS2 organisation unit first");
  if (problems.length) throw new ValidationError(problems.join("; "));
  const startedAt = new Date();
  let outcome: { status: "verified" | "failed"; detail: string; orgUnitName: string | null; version: string | null };
  try {
    const client = await clientFor(c, row);
    const info = await client.systemInfo();
    const unit = await client.verifyOrgUnit(String(row.dhis2OrgUnitUid));
    outcome = unit.assigned
      ? { status: "verified", detail: `Reached DHIS2 ${info.version ?? "(version not reported)"}; organisation unit ${unit.name} is in the account's data-capture hierarchy`, orgUnitName: unit.name, version: info.version }
      : { status: "failed", detail: `Organisation unit ${unit.name} is not assigned to this DHIS2 account`, orgUnitName: unit.name, version: info.version };
  } catch (error) {
    outcome = { status: "failed", detail: failureMessage(error), orgUnitName: null, version: null };
  }
  await withStaffActor(c, async (tx) => {
    await tx`
      update hmis_integrations set connection_status = ${outcome.status}, connection_checked_at = now(), connection_detail = ${outcome.detail},
        dhis2_org_unit_name = coalesce(${outcome.orgUnitName}, dhis2_org_unit_name),
        connection_fingerprint = ${outcome.status === "verified" ? await connectionFingerprint(row) : null},
        live_submission_enabled = ${outcome.status === "verified" ? Boolean(row.liveSubmissionEnabled) : false}, updated_at = now()
       where tenant_id = ${tenantId}`;
    await ledger(tx, {
      tenantId, kind: "connection-test", outcome: outcome.status === "verified" ? "succeeded" : "failed", actorUserId: auth.user.id, startedAt,
      summary: { dhis2Version: outcome.version, orgUnitAssigned: outcome.status === "verified" }, error: outcome.status === "failed" ? outcome.detail : null,
    });
    await writeAudit(tx, config, requestAudit(c, "ehmis.connection.test", { resourceType: "HmisIntegration", resourceId: tenantId, metadata: { outcome: outcome.status } }));
  });
  return c.json({ ok: outcome.status === "verified", connectionStatus: outcome.status, detail: outcome.detail });
});

ehmisRoutes.post("/ehmis/live-submission", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "hmis.integration.manage");
  const body = await parseJson(c, hmisLiveSubmissionSchema);
  const config = c.get("deps").config;
  const tenantId = auth.activeTenant!.id;
  await withStaffActor(c, async (tx) => {
    const row = await loadIntegration(tx, tenantId);
    if (body.enabled) {
      const readiness = await liveReadiness(config, { ...row, liveSubmissionEnabled: true }, today());
      if (!readiness.ready) throw new ConflictError(`Live submission cannot be switched on: ${readiness.problems.join("; ")}`);
    }
    await tx`update hmis_integrations set live_submission_enabled = ${body.enabled}, updated_by = ${auth.user.id}, updated_at = now() where tenant_id = ${tenantId}`;
    await writeAudit(tx, config, requestAudit(c, "ehmis.live-submission", { resourceType: "HmisIntegration", resourceId: tenantId, metadata: { enabled: body.enabled } }));
  });
  return c.json({ ok: true, liveSubmissionEnabled: body.enabled });
});

ehmisRoutes.put("/ehmis/rules", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "hmis.integration.manage");
  const body = await parseJson(c, hmisReportingRuleSchema);
  const tenantId = auth.activeTenant!.id;
  await withStaffActor(c, async (tx) => {
    await tx`
      insert into hmis_reporting_rules (id, tenant_id, period_type, submission_due_day, validation_start_day, validation_end_day, lock_after_day, source, verified_on, updated_by)
      values (${crypto.randomUUID()}, ${tenantId}, ${body.periodType}, ${body.submissionDueDay}, ${body.validationStartDay}, ${body.validationEndDay},
        ${body.lockAfterDay}, ${body.source}, current_date, ${auth.user.id})
      on conflict (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), period_type) do update set
        submission_due_day = excluded.submission_due_day, validation_start_day = excluded.validation_start_day,
        validation_end_day = excluded.validation_end_day, lock_after_day = excluded.lock_after_day, source = excluded.source,
        verified_on = excluded.verified_on, updated_by = excluded.updated_by, updated_at = now()`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "ehmis.rule.update", { resourceType: "HmisReportingRule", resourceId: null, metadata: body }));
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- platform verification of eligibility

ehmisRoutes.get("/ehmis/eligibility-requests", async (c) => {
  if (!isPlatformOperator(c)) throw new ForbiddenError("Platform operator permission is required");
  const rows = await withPlatformActor(c, async (tx) => tx`
    select h.tenant_id, t.name as facility_name, t.service_category, t.level_status, t.official_level, h.nhfr_id, h.dhis2_org_unit_uid,
           h.eligibility_status, h.authorization_reference, h.authorization_issuer, h.authorization_valid_until, h.eligibility_requested_at,
           h.eligibility_decided_at, h.eligibility_decision_note, u.display_name as requested_by_name,
           (select string_agg(r.kind || ' ' || r.identifier, '; ') from facility_registrations r where r.tenant_id = h.tenant_id and r.status <> 'withdrawn') as registrations
      from hmis_integrations h join tenants t on t.id = h.tenant_id left join users u on u.id = h.eligibility_requested_by
     where h.eligibility_status <> 'not-assessed'
     order by (h.eligibility_status = 'pending-verification') desc, h.eligibility_requested_at desc limit 200`);
  return c.json({ requests: rows });
});

/** A platform operator records the result of checking the facility's Ministry authorization evidence. */
ehmisRoutes.post("/ehmis/eligibility/:tenantId/decision", async (c) => {
  if (!isPlatformOperator(c)) throw new ForbiddenError("Platform operator permission is required");
  const auth = c.get("auth")!;
  const tenantId = uuidSchema.parse(c.req.param("tenantId"));
  const body = await parseJson(c, hmisEligibilityDecisionSchema);
  await withPlatformActor(c, async (tx) => {
    const row = await requireRows(await tx`select * from hmis_integrations where tenant_id = ${tenantId} for update`, "No eHMIS request for this facility");
    if (body.decision === "verified" && row.eligibilityStatus !== "pending-verification") throw new ConflictError(`The request is ${row.eligibilityStatus}`);
    if (row.eligibilityRequestedBy === auth.user.id) throw new ForbiddenError("The person who recorded the authorization cannot verify it");
    await tx`
      update hmis_integrations set eligibility_status = ${body.decision}, eligibility_decided_by = ${auth.user.id}, eligibility_decided_at = now(),
        eligibility_decision_note = ${body.note}, live_submission_enabled = ${body.decision === "verified" ? Boolean(row.liveSubmissionEnabled) : false}, updated_at = now()
       where tenant_id = ${tenantId}`;
    await writeAudit(tx, c.get("deps").config, {
      tenantId, actorKind: "staff", actorUserId: auth.user.id, actorRoles: [], action: "ehmis.eligibility.decision",
      resourceType: "HmisIntegration", resourceId: tenantId, metadata: { decision: body.decision },
    });
  });
  return c.json({ ok: true, eligibilityStatus: body.decision });
});

// ---------------------------------------------------------------- dataset mappings

ehmisRoutes.post("/ehmis/mappings", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "hmis.integration.manage");
  const body = await parseJson(c, hmisMappingSchema);
  const id = crypto.randomUUID();
  try {
    await withStaffActor(c, async (tx) => {
      await tx`
        insert into hmis_dataset_mappings (id, tenant_id, dataset_code, dataset_name, dhis2_data_set_uid, period_type, attribute_option_combo_uid, elements, created_by)
        values (${id}, ${auth.activeTenant!.id}, ${body.datasetCode}, ${body.datasetName}, ${body.dhis2DataSetUid}, ${body.periodType},
          ${body.attributeOptionComboUid ?? null}, ${tx.json(body.elements as never)}, ${auth.user.id})`;
      await writeAudit(tx, c.get("deps").config, requestAudit(c, "ehmis.mapping.create", {
        resourceType: "HmisDatasetMapping", resourceId: id, metadata: { datasetCode: body.datasetCode, elements: body.elements.length },
      }));
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new ConflictError("This DHIS2 dataset is already mapped for the facility; retire the existing mapping first");
    throw error;
  }
  return c.json({ ok: true, id, status: "draft" }, 201);
});

ehmisRoutes.post("/ehmis/mappings/:id/approve", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "hmis.integration.manage");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, hmisMappingApproveSchema);
  await withStaffActor(c, async (tx) => {
    const mapping = await requireRows(await tx`select * from hmis_dataset_mappings where id = ${id} and tenant_id = ${auth.activeTenant!.id} for update`, "Mapping not found");
    ensureMatch(body.expectedVersion, Number(mapping.version));
    if (mapping.status !== "draft") throw new ConflictError(`The mapping is ${mapping.status}`);
    await tx`
      update hmis_dataset_mappings set status = 'approved', approval_reference = ${body.approvalReference}, approved_by = ${auth.user.id},
        approved_at = now(), version = version + 1, updated_at = now() where id = ${id}`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "ehmis.mapping.approve", { resourceType: "HmisDatasetMapping", resourceId: id, metadata: { reference: body.approvalReference } }));
  });
  return c.json({ ok: true });
});

ehmisRoutes.post("/ehmis/mappings/:id/retire", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "hmis.integration.manage");
  const id = uuidSchema.parse(c.req.param("id"));
  await withStaffActor(c, async (tx) => {
    const rows = await tx`update hmis_dataset_mappings set status = 'retired', version = version + 1, updated_at = now() where id = ${id} and tenant_id = ${auth.activeTenant!.id} and status <> 'retired' returning id`;
    if (!rows[0]) throw new NotFoundError("Mapping not found");
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "ehmis.mapping.retire", { resourceType: "HmisDatasetMapping", resourceId: id }));
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- reporting periods

interface Prepared {
  values: ComputedValue[];
  issues: ValidationIssue[];
  payload: DataValueSet;
  digest: string;
}

async function prepare(tx: Tx, tenantId: string, mapping: Record<string, unknown>, period: string, orgUnit: string | null): Promise<Prepared> {
  const parsed = periodDates(period, mapping.periodType as PeriodType);
  const values = await computeValues(tx, tenantId, mapping.elements as MappingElement[], parsed);
  const rule = await effectiveRule(tx, tenantId, mapping.periodType as PeriodType);
  const issues = validate({ values, parsed, today: today(), orgUnit, mappingApproved: mapping.status === "approved", scheduleInfo: schedule(parsed, rule, today()) });
  const payload = dataValueSet({
    dataSetUid: String(mapping.dhis2DataSetUid), period, orgUnit: orgUnit ?? "", attributeOptionCombo: (mapping.attributeOptionComboUid as string | null) ?? null,
    values, completedDate: today(),
  });
  return { values, issues, payload, digest: await payloadDigest(payload) };
}

ehmisRoutes.post("/ehmis/periods", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "hmis.report.prepare");
  const body = await parseJson(c, hmisPeriodGenerateSchema);
  const tenantId = auth.activeTenant!.id;
  const result = await withStaffActor(c, async (tx) => {
    const mapping = await requireRows(await tx`select * from hmis_dataset_mappings where id = ${body.mappingId} and tenant_id = ${tenantId} and status <> 'retired'`, "Mapping not found");
    const parsed = periodDates(body.period, mapping.periodType as PeriodType);
    const existing = await tx`select id, status from hmis_report_periods where tenant_id = ${tenantId} and mapping_id = ${body.mappingId} and period = ${body.period} and status <> 'superseded'`;
    if (existing[0]) throw new ConflictError(`This period is already ${existing[0].status}; reopen it to prepare a new revision`, { periodId: existing[0].id });
    const integration = await loadIntegration(tx, tenantId);
    const prepared = await prepare(tx, tenantId, mapping, body.period, (integration.dhis2OrgUnitUid as string | null) ?? null);
    const id = crypto.randomUUID();
    const status = prepared.issues.some((issue) => issue.severity === "error") ? "validation-failed" : "generated";
    const key = idempotencyKey({ tenantId, dataSetUid: String(mapping.dhis2DataSetUid), orgUnit: String(integration.dhis2OrgUnitUid ?? ""), period: body.period, revision: 1 });
    await tx`
      insert into hmis_report_periods (id, tenant_id, mapping_id, period, period_start, period_end, revision, status, data_values, validation, content_digest, idempotency_key, generated_by)
      values (${id}, ${tenantId}, ${body.mappingId}, ${body.period}, ${parsed.start}, ${parsed.end}, 1, ${status}, ${tx.json(prepared.values as never)},
        ${tx.json(prepared.issues as never)}, ${prepared.digest}, ${key}, ${auth.user.id})`;
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "ehmis.period.generate", {
      resourceType: "HmisReportPeriod", resourceId: id, metadata: { period: body.period, datasetCode: mapping.datasetCode, status, errors: prepared.issues.filter((issue) => issue.severity === "error").length },
    }));
    return { id, status, issues: prepared.issues };
  });
  return c.json({ ok: true, period: result }, 201);
});

async function lockPeriod(tx: Tx, tenantId: string, id: string) {
  return requireRows(await tx`
    select p.*, m.dhis2_data_set_uid, m.period_type, m.attribute_option_combo_uid, m.elements, m.status as mapping_status, m.dataset_code
      from hmis_report_periods p join hmis_dataset_mappings m on m.id = p.mapping_id
     where p.id = ${id} and p.tenant_id = ${tenantId} for update of p`, "Reporting period not found");
}

/** Approval recomputes the values; a period whose data changed since it was generated must be regenerated first. */
ehmisRoutes.post("/ehmis/periods/:id/approve", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "hmis.report.prepare");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, hmisPeriodApproveSchema);
  const tenantId = auth.activeTenant!.id;
  await withStaffActor(c, async (tx) => {
    const period = await lockPeriod(tx, tenantId, id);
    ensureMatch(body.expectedVersion, Number(period.version));
    if (period.status !== "generated") throw new ConflictError(`A ${period.status} period cannot be approved`);
    const integration = await loadIntegration(tx, tenantId);
    const prepared = await prepare(tx, tenantId, { ...period, periodType: period.periodType, status: period.mappingStatus, dhis2DataSetUid: period.dhis2DataSetUid, attributeOptionComboUid: period.attributeOptionComboUid },
      String(period.period), (integration.dhis2OrgUnitUid as string | null) ?? null);
    if (prepared.issues.some((issue) => issue.severity === "error")) throw new ConflictError("The period no longer validates", { issues: prepared.issues });
    if (prepared.digest !== period.contentDigest) throw new ConflictError("Source data changed since this period was generated; reopen it to regenerate the values");
    await tx`update hmis_report_periods set status = 'approved', approved_by = ${auth.user.id}, approved_at = now(), approval_note = ${body.note || null}, version = version + 1, updated_at = now() where id = ${id}`;
    await ledger(tx, { tenantId, periodId: id, kind: "status-change", outcome: "succeeded", actorUserId: auth.user.id, startedAt: new Date(), summary: { to: "approved" } });
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "ehmis.period.approve", { resourceType: "HmisReportPeriod", resourceId: id, metadata: { period: period.period } }));
  });
  return c.json({ ok: true, status: "approved" });
});

ehmisRoutes.post("/ehmis/periods/:id/reopen", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "hmis.report.prepare");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, hmisPeriodReopenSchema);
  const tenantId = auth.activeTenant!.id;
  const result = await withStaffActor(c, async (tx) => {
    const period = await lockPeriod(tx, tenantId, id);
    ensureMatch(body.expectedVersion, Number(period.version));
    if (period.status === "submitting" && Date.now() - (period.updatedAt as Date).getTime() <= STALE_SUBMISSION_MS) throw new ConflictError("A submission is in progress");
    await tx`update hmis_report_periods set status = 'superseded', reopened_reason = ${body.reason}, version = version + 1, updated_at = now() where id = ${id}`;
    const integration = await loadIntegration(tx, tenantId);
    const mapping = await requireRows(await tx`select * from hmis_dataset_mappings where id = ${period.mappingId}`, "Mapping not found");
    const prepared = await prepare(tx, tenantId, mapping, String(period.period), (integration.dhis2OrgUnitUid as string | null) ?? null);
    const revision = Number(period.revision) + 1;
    const nextId = crypto.randomUUID();
    const status = prepared.issues.some((issue) => issue.severity === "error") ? "validation-failed" : "generated";
    const key = idempotencyKey({ tenantId, dataSetUid: String(mapping.dhis2DataSetUid), orgUnit: String(integration.dhis2OrgUnitUid ?? ""), period: String(period.period), revision });
    await tx`
      insert into hmis_report_periods (id, tenant_id, mapping_id, period, period_start, period_end, revision, status, data_values, validation, content_digest, idempotency_key, generated_by)
      values (${nextId}, ${tenantId}, ${period.mappingId}, ${period.period}, ${period.periodStart}, ${period.periodEnd}, ${revision}, ${status},
        ${tx.json(prepared.values as never)}, ${tx.json(prepared.issues as never)}, ${prepared.digest}, ${key}, ${auth.user.id})`;
    await ledger(tx, { tenantId, periodId: id, kind: "status-change", outcome: "succeeded", actorUserId: auth.user.id, startedAt: new Date(), summary: { to: "superseded", revision }, error: null });
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "ehmis.period.reopen", { resourceType: "HmisReportPeriod", resourceId: nextId, metadata: { period: period.period, revision, reason: body.reason, previousStatus: period.status } }));
    return { id: nextId, revision, status };
  });
  return c.json({ ok: true, period: result }, 201);
});

ehmisRoutes.get("/ehmis/periods/:id/export", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "hmis.report.prepare");
  const id = uuidSchema.parse(c.req.param("id"));
  const format = c.req.query("format") === "csv" ? "csv" : "json";
  const tenantId = auth.activeTenant!.id;
  const payload = await withStaffActor(c, async (tx) => {
    const period = await lockPeriod(tx, tenantId, id);
    if (!["approved", "failed", "exported", "submitted", "submitted-manually"].includes(String(period.status))) {
      throw new ConflictError("Only an approved period can be exported for manual entry");
    }
    const integration = await loadIntegration(tx, tenantId);
    const values = period.dataValues as ComputedValue[];
    const set = dataValueSet({
      dataSetUid: String(period.dhis2DataSetUid), period: String(period.period), orgUnit: String(integration.dhis2OrgUnitUid ?? ""),
      attributeOptionCombo: (period.attributeOptionComboUid as string | null) ?? null, values, completedDate: today(),
    });
    if (["approved", "failed"].includes(String(period.status))) await tx`update hmis_report_periods set status = 'exported', version = version + 1, updated_at = now() where id = ${id}`;
    await ledger(tx, { tenantId, periodId: id, kind: "manual-export", outcome: "succeeded", idempotencyKey: String(period.idempotencyKey), requestDigest: String(period.contentDigest), actorUserId: auth.user.id, startedAt: new Date(), summary: { format, values: values.length } });
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "ehmis.period.export", { resourceType: "HmisReportPeriod", resourceId: id, metadata: { period: period.period, format } }));
    return { set, name: `${String(period.datasetCode).replace(/[^A-Za-z0-9-]+/g, "-")}-${period.period}-r${period.revision}` };
  });
  if (format === "csv") {
    return new Response(dhis2Csv(payload.set), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${payload.name}.csv"`, "cache-control": "no-store, private" } });
  }
  return new Response(JSON.stringify(payload.set, null, 2), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${payload.name}.json"`, "cache-control": "no-store, private" } });
});

ehmisRoutes.post("/ehmis/periods/:id/manual-submission", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "hmis.report.submit");
  const id = uuidSchema.parse(c.req.param("id"));
  const body = await parseJson(c, hmisManualSubmissionSchema);
  const tenantId = auth.activeTenant!.id;
  await withStaffActor(c, async (tx) => {
    const period = await lockPeriod(tx, tenantId, id);
    ensureMatch(body.expectedVersion, Number(period.version));
    if (!["approved", "exported", "failed"].includes(String(period.status))) throw new ConflictError(`A ${period.status} period cannot be marked as entered manually`);
    await tx`update hmis_report_periods set status = 'submitted-manually', manual_reference = ${body.reference}, submitted_at = now(), version = version + 1, updated_at = now() where id = ${id}`;
    await ledger(tx, { tenantId, periodId: id, kind: "manual-submission", outcome: "succeeded", idempotencyKey: String(period.idempotencyKey), requestDigest: String(period.contentDigest), actorUserId: auth.user.id, startedAt: new Date(), summary: { reference: body.reference } });
    await writeAudit(tx, c.get("deps").config, requestAudit(c, "ehmis.period.manual-submission", { resourceType: "HmisReportPeriod", resourceId: id, metadata: { period: period.period } }));
  });
  return c.json({ ok: true, status: "submitted-manually" });
});

/**
 * Live submission: a DHIS2 dry run, then the import. The period row is the idempotency record: a period
 * revision that was already submitted is never sent again, and a concurrent attempt is refused.
 */
ehmisRoutes.post("/ehmis/periods/:id/submit", async (c) => {
  const auth = requireStaff(c);
  requirePermission(c, "hmis.report.submit");
  await enforceRateLimit(c, "integration.request", auth.user.id);
  const id = uuidSchema.parse(c.req.param("id"));
  const deps = c.get("deps");
  const config = deps.config;
  const tenantId = auth.activeTenant!.id;
  const context = { tenantId, userId: auth.user.id, actorKind: "staff" as const, roles: auth.activeTenant!.roles };
  const startedAt = new Date();
  const claim = await withStaffActor(c, async (tx) => {
    const period = await lockPeriod(tx, tenantId, id);
    if (period.status === "submitted") {
      await ledger(tx, { tenantId, periodId: id, kind: "live", outcome: "skipped-duplicate", idempotencyKey: String(period.idempotencyKey), requestDigest: String(period.contentDigest), actorUserId: auth.user.id, startedAt, summary: { reason: "already submitted" } });
      return { replay: true as const, period };
    }
    // A claim left behind by a crashed request may be retried; DHIS2 data value imports overwrite rather than duplicate.
    const staleClaim = period.status === "submitting" && Date.now() - (period.updatedAt as Date).getTime() > STALE_SUBMISSION_MS;
    if (!["approved", "failed", "exported"].includes(String(period.status)) && !staleClaim) throw new ConflictError(`A ${period.status} period cannot be submitted`);
    const integration = await loadIntegration(tx, tenantId);
    const readiness = await liveReadiness(config, integration, today());
    if (!readiness.ready) return { refused: readiness.problems, period };
    await tx`update hmis_report_periods set status = 'submitting', attempt_count = attempt_count + 1, updated_at = now() where id = ${id}`;
    return { replay: false as const, period, integration };
  });
  if ("refused" in claim && claim.refused) {
    await withContext(deps.sql, context, (tx) => ledger(tx, {
      tenantId, periodId: id, kind: "live", outcome: "refused", idempotencyKey: String(claim.period.idempotencyKey), actorUserId: auth.user.id, startedAt,
      error: claim.refused.join("; "),
    }));
    throw new IntegrationUnavailableError({ ...integrationStatus(config, "ehmis"), reason: claim.refused.join("; ") }, "ehmis.period.submit", `nothing was sent to eHMIS/DHIS2: ${claim.refused.join("; ")}`);
  }
  if ("replay" in claim && claim.replay) {
    return c.json({ ok: true, replayed: true, status: "submitted", importSummary: claim.period.importSummary });
  }
  const { period, integration } = claim as { period: Record<string, unknown>; integration: Record<string, unknown> };
  const payload = dataValueSet({
    dataSetUid: String(period.dhis2DataSetUid), period: String(period.period), orgUnit: String(integration.dhis2OrgUnitUid),
    attributeOptionCombo: (period.attributeOptionComboUid as string | null) ?? null, values: period.dataValues as ComputedValue[], completedDate: today(),
  });
  const base = { tenantId, periodId: id, idempotencyKey: String(period.idempotencyKey), requestDigest: String(period.contentDigest), actorUserId: auth.user.id };
  let finalStatus: "submitted" | "failed" = "failed";
  let summary: Record<string, unknown> = {};
  let error: string | null = null;
  const entries: Array<Parameters<typeof ledger>[1]> = [];
  try {
    const client = await clientFor(c, integration);
    const dryStarted = new Date();
    const dry = await client.submit(payload, { dryRun: true });
    const dryOk = dry.outcome.status !== "ERROR" && dry.outcome.conflicts.length === 0 && dry.outcome.ignored === 0;
    entries.push({ ...base, kind: "dry-run", outcome: dryOk ? "succeeded" : "rejected", httpStatus: dry.httpStatus, summary: { ...dry.outcome }, startedAt: dryStarted, error: dryOk ? null : "DHIS2 dry run reported conflicts or ignored values" });
    if (!dryOk) {
      summary = { ...dry.outcome, stage: "dry-run" };
      error = "DHIS2 dry run reported conflicts or ignored values; nothing was imported";
    } else {
      const liveStarted = new Date();
      const live = await client.submit(payload, { dryRun: false });
      const liveOk = live.outcome.status !== "ERROR" && live.outcome.conflicts.length === 0 && live.outcome.ignored === 0;
      entries.push({ ...base, kind: "live", outcome: liveOk ? "succeeded" : "rejected", httpStatus: live.httpStatus, summary: { ...live.outcome }, startedAt: liveStarted, error: liveOk ? null : "DHIS2 reported conflicts or ignored values" });
      summary = { ...live.outcome, stage: "import" };
      if (liveOk) finalStatus = "submitted";
      else error = "DHIS2 reported conflicts or ignored values";
    }
  } catch (caught) {
    error = failureMessage(caught);
    entries.push({ ...base, kind: "live", outcome: "failed", httpStatus: caught instanceof Dhis2Error ? caught.httpStatus : null, error, startedAt });
  }
  await withContext(deps.sql, context, async (tx) => {
    for (const entry of entries) await ledger(tx, entry);
    await tx`
      update hmis_report_periods set status = ${finalStatus}, import_summary = ${tx.json(summary as never)}, last_error = ${error},
        submitted_at = ${finalStatus === "submitted" ? new Date() : null}, version = version + 1, updated_at = now()
       where id = ${id}`;
    await writeAudit(tx, config, requestAudit(c, "ehmis.period.submit", {
      resourceType: "HmisReportPeriod", resourceId: id, metadata: { period: period.period, outcome: finalStatus, imported: summary.imported ?? null, updated: summary.updated ?? null },
    }));
  });
  return c.json({ ok: finalStatus === "submitted", replayed: false, status: finalStatus, importSummary: summary, error });
});
