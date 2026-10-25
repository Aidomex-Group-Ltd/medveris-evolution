import { Hono, type Context } from "hono";
import type { ActorContext } from "@medveris/authz";
import type { Tx } from "@medveris/db";
import { withActor, withStaffActor } from "../auth/middleware.js";
import { AppError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import type { AppEnv } from "../types.js";
import { capabilityStatement } from "./capability.js";
import {
  allergyResource,
  auditEventResource,
  conditionResource,
  consentResource,
  documentReferenceResource,
  encounterResource,
  observationResource,
  organizationResource,
  patientResource,
  practitionerResource,
  practitionerRoleResource,
  provenanceResource,
} from "./mapping.js";

export const fhirRoutes = new Hono<AppEnv>();

const FHIR_CONTENT = "application/fhir+json; charset=utf-8";

function fhir(c: Context<AppEnv>, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": FHIR_CONTENT,
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
    },
  });
}

export function operationOutcome(severity: "error" | "warning" | "information", code: string, diagnostics: string) {
  return {
    resourceType: "OperationOutcome",
    issue: [{ severity, code, diagnostics }],
  };
}

function requireFhirAuth(c: Context<AppEnv>) {
  const auth = c.get("auth");
  if (!auth) throw new AppError(401, "login", "Authentication required");
  return auth;
}

async function runFhir<T>(c: Context<AppEnv>, fn: (tx: Tx, actor: ActorContext) => Promise<T>): Promise<T> {
  const auth = requireFhirAuth(c);
  if (auth.activeTenant) {
    return withStaffActor(c, async (tx) => {
      const actor: ActorContext = {
        userId: auth.user.id,
        roles: auth.activeTenant?.roles ?? [],
        tenantId: auth.activeTenant?.id ?? null,
        patientId: auth.patientId,
        mfaVerified: auth.mfaVerified,
        mfaEnrolled: Boolean(auth.user.mfaEnrolledAt),
        platformRoles: auth.platformRoles,
      };
      return fn(tx, actor);
    });
  }
  if (!auth.patientId) throw new ForbiddenError("A patient or staff context is required");
  return withActor(c, async (tx) => {
    const actor: ActorContext = {
      userId: auth.user.id,
      roles: ["patient"],
      tenantId: null,
      patientId: auth.patientId,
      mfaVerified: auth.mfaVerified,
      mfaEnrolled: Boolean(auth.user.mfaEnrolledAt),
      platformRoles: auth.platformRoles,
    };
    return fn(tx, actor);
  });
}

function pagination(c: Context<AppEnv>): { count: number; offset: number } {
  const rawCount = Number(c.req.query("_count") ?? 20);
  const rawOffset = Number(c.req.query("_offset") ?? 0);
  return {
    count: Number.isFinite(rawCount) ? Math.min(Math.max(1, Math.trunc(rawCount)), 50) : 20,
    offset: Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0,
  };
}

function bundle(c: Context<AppEnv>, resourceType: string, entries: unknown[], total: number, offset: number, count: number) {
  const base = `${c.get("deps").config.origin}/fhir/r4/${resourceType}`;
  const qs = new URLSearchParams(c.req.query() as Record<string, string>);
  qs.set("_offset", String(offset + count));
  qs.set("_count", String(count));
  return {
    resourceType: "Bundle",
    id: crypto.randomUUID(),
    type: "searchset",
    total,
    link: [
      { relation: "self", url: `${base}?${new URLSearchParams(c.req.query() as Record<string, string>).toString()}` },
      ...(offset + count < total ? [{ relation: "next", url: `${base}?${qs.toString()}` }] : []),
    ],
    entry: entries.map((resource) => ({ fullUrl: `${base}/${(resource as { id: string }).id}`, resource })),
  };
}

function rejectUnsupportedParams(c: Context<AppEnv>, allowed: string[]): void {
  for (const key of Object.keys(c.req.query())) {
    if (!allowed.includes(key)) throw new ValidationError(`Unsupported search parameter: ${key}`);
  }
}

function patientReference(value: string | undefined): string | null {
  if (!value) return null;
  return value.startsWith("Patient/") ? value.slice("Patient/".length) : value;
}

function publicPatientId(c: Context<AppEnv>): string | null {
  return patientReference(c.req.query("patient") ?? c.req.query("subject") ?? c.req.query("identifier") ?? c.req.query("_id") ?? undefined);
}

fhirRoutes.use("/fhir/r4/*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    return fhir(c, operationOutcome("error", "not-supported", "FHIR writes, transactions and bundles are disabled in this MVP"), 405);
  }
  await next();
});

fhirRoutes.get("/fhir/r4/metadata", (c) => fhir(c, capabilityStatement()));

fhirRoutes.get("/fhir/r4/Patient", async (c) => {
  if (c.req.query("_include") || c.req.query("_revinclude") || c.req.query("_history")) {
    return fhir(c, operationOutcome("error", "not-supported", "Includes and history are not supported"), 400);
  }
  const { count, offset } = pagination(c);
  const auth = requireFhirAuth(c);
  const identifier = c.req.query("identifier") ?? null;
  const id = c.req.query("_id") ?? null;
  const lookup = id ?? identifier;
  if (!identifier && !id) {
    return fhir(c, operationOutcome("error", "invalid", "Patient search requires an exact identifier or _id"), 400);
  }
  return runFhir(c, async (tx) => {
    const rows = await tx`
      select p.id, p.public_id, p.given_name, p.family_name, p.date_of_birth, p.sex, p.email, p.phone,
             p.merged_into, p.updated_at
        from patients p
       where p.public_id = ${lookup}
         and (
           (${auth.patientId}::uuid is not null and p.id = ${auth.patientId})
           or (${auth.activeTenant?.id ?? null}::uuid is not null and exists (
             select 1 from tenant_patient_links l
              where l.patient_id = p.id and l.tenant_id = ${auth.activeTenant?.id ?? null}
           ))
         )
       order by p.created_at limit ${count} offset ${offset}
    `;
    const totalRows = await tx`
      select count(*)::int as count from patients p
       where p.public_id = ${lookup}
         and (
           (${auth.patientId}::uuid is not null and p.id = ${auth.patientId})
           or (${auth.activeTenant?.id ?? null}::uuid is not null and exists (
             select 1 from tenant_patient_links l
              where l.patient_id = p.id and l.tenant_id = ${auth.activeTenant?.id ?? null}
           ))
         )
    `;
    const total = Number(totalRows[0]?.count ?? 0);
    return fhir(c, bundle(c, "Patient", rows.map(patientResource), total, offset, count));
  });
});

fhirRoutes.get("/fhir/r4/Patient/:id", async (c) => {
  if (c.req.param("id") === "_history") return fhir(c, operationOutcome("error", "not-supported", "History is not supported"), 400);
  const id = c.req.param("id");
  return runFhir(c, async (tx) => {
    const rows = await tx`
      select p.id, p.public_id, p.given_name, p.family_name, p.date_of_birth, p.sex, p.email, p.phone,
             p.merged_into, p.updated_at
        from patients p
       where p.public_id = ${id}
         and (
           (${c.get("auth")?.patientId ?? null}::uuid is not null and p.id = ${c.get("auth")?.patientId ?? null})
           or (${c.get("auth")?.activeTenant?.id ?? null}::uuid is not null and exists (
             select 1 from tenant_patient_links l
              where l.patient_id = p.id and l.tenant_id = ${c.get("auth")?.activeTenant?.id ?? null}
           ))
         )
       limit 1
    `;
    if (!rows[0]) throw new NotFoundError("Patient not found");
    return fhir(c, patientResource(rows[0]));
  });
});

fhirRoutes.get("/fhir/r4/Organization/:id", async (c) => {
  const id = c.req.param("id");
  return runFhir(c, async (tx, actor) => {
    if (!actor.tenantId) throw new ForbiddenError("Organization access requires a facility context");
    if (id !== actor.tenantId) throw new NotFoundError("Organization not found");
    const rows = await tx`select * from tenants where id = ${id} limit 1`;
    if (!rows[0]) throw new NotFoundError("Organization not found");
    return fhir(c, organizationResource(rows[0]));
  });
});

fhirRoutes.get("/fhir/r4/Organization", async (c) => {
  const { count, offset } = pagination(c);
  return runFhir(c, async (tx, actor) => {
    if (!actor.tenantId) throw new ForbiddenError("Organization access requires a facility context");
    const rows = await tx`select * from tenants where id = ${actor.tenantId} order by name limit ${count} offset ${offset}`;
    return fhir(c, bundle(c, "Organization", rows.map(organizationResource), rows.length, offset, count));
  });
});

fhirRoutes.get("/fhir/r4/Practitioner/:id", async (c) => {
  const id = c.req.param("id");
  return runFhir(c, async (tx, actor) => {
    if (!actor.tenantId) throw new ForbiddenError("Staff directory access is not available to patient accounts");
    const rows = await tx`
      select distinct u.* from users u join memberships m on m.user_id = u.id
       where u.id = ${id} and m.tenant_id = ${actor.tenantId} and m.status = 'active'
    `;
    if (!rows[0]) throw new NotFoundError("Practitioner not found");
    return fhir(c, practitionerResource(rows[0]));
  });
});

fhirRoutes.get("/fhir/r4/Practitioner", async (c) => {
  const { count, offset } = pagination(c);
  return runFhir(c, async (tx, actor) => {
    if (!actor.tenantId) throw new ForbiddenError("Staff directory access is not available to patient accounts");
    const rows = await tx`
      select distinct u.* from users u join memberships m on m.user_id = u.id
       where m.tenant_id = ${actor.tenantId} and m.status = 'active'
       order by u.family_name limit ${count} offset ${offset}
    `;
    return fhir(c, bundle(c, "Practitioner", rows.map(practitionerResource), rows.length, offset, count));
  });
});

fhirRoutes.get("/fhir/r4/PractitionerRole/:id", async (c) => {
  const id = c.req.param("id");
  return runFhir(c, async (tx, actor) => {
    if (!actor.tenantId) throw new ForbiddenError("PractitionerRole access requires a facility context");
    const rows = await tx`select * from memberships where id = ${id} and tenant_id = ${actor.tenantId}`;
    if (!rows[0]) throw new NotFoundError("PractitionerRole not found");
    return fhir(c, practitionerRoleResource(rows[0]));
  });
});

const resourceQueries: Record<string, { table: string; profile: string; mapper: (row: Record<string, unknown>) => unknown }> = {
  Encounter: { table: "encounters", profile: "Encounter", mapper: encounterResource },
  Observation: { table: "observations", profile: "Observation", mapper: observationResource },
  Condition: { table: "conditions", profile: "Condition", mapper: conditionResource },
  AllergyIntolerance: { table: "allergies", profile: "AllergyIntolerance", mapper: allergyResource },
};

async function patientInternalId(tx: Tx, publicId: string, actor: ActorContext): Promise<string> {
  if (actor.patientId) {
    const rows = await tx`select id, public_id from patients where id = ${actor.patientId}`;
    if (String(rows[0]?.publicId) !== publicId) throw new NotFoundError("Patient not found");
    return String(rows[0]!.id);
  }
  if (!actor.tenantId) throw new ForbiddenError("A patient or facility context is required");
  const rows = await tx`
    select p.id from patients p join tenant_patient_links l on l.patient_id = p.id
     where p.public_id = ${publicId} and l.tenant_id = ${actor.tenantId} limit 1
  `;
  if (!rows[0]) throw new NotFoundError("Patient not found in this facility");
  return String(rows[0].id);
}

for (const [resourceType, config] of Object.entries(resourceQueries)) {
  fhirRoutes.get(`/fhir/r4/${resourceType}`, async (c) => {
    rejectUnsupportedParams(c, ["patient", "subject", "_count", "_offset"]);
    const { count, offset } = pagination(c);
    const reference = publicPatientId(c);
    if (!reference) return fhir(c, operationOutcome("error", "invalid", "A patient/subject constrained search is required"), 400);
    return runFhir(c, async (tx, actor) => {
      const internal = await patientInternalId(tx, reference, actor);
      const rows = await tx`
        select * from ${tx(config.table)} where patient_id = ${internal}
        order by ${config.table === "encounters" ? tx("opened_at") : tx("recorded_at")} desc
        limit ${count} offset ${offset}
      `;
      const totalRows = await tx`select count(*)::int as count from ${tx(config.table)} where patient_id = ${internal}`;
      return fhir(c, bundle(c, resourceType, rows.map((row) => config.mapper(row as Record<string, unknown>)), Number(totalRows[0]?.count ?? 0), offset, count));
    });
  });

  fhirRoutes.get(`/fhir/r4/${resourceType}/:id`, async (c) => {
    const id = c.req.param("id");
    if (id === "_history") return fhir(c, operationOutcome("error", "not-supported", "History is not supported"), 400);
    return runFhir(c, async (tx) => {
      const rows = await tx`select * from ${tx(config.table)} where id = ${id} limit 1`;
      if (!rows[0]) throw new NotFoundError(`${resourceType} not found`);
      return fhir(c, config.mapper(rows[0] as Record<string, unknown>));
    });
  });
}

fhirRoutes.get("/fhir/r4/DocumentReference", async (c) => {
  rejectUnsupportedParams(c, ["patient", "subject", "_count", "_offset"]);
  const { count, offset } = pagination(c);
  const reference = publicPatientId(c);
  if (!reference) return fhir(c, operationOutcome("error", "invalid", "A patient/subject constrained search is required"), 400);
  return runFhir(c, async (tx, actor) => {
    const internal = await patientInternalId(tx, reference, actor);
    const rows = await tx`
      select v.*, p.public_id, p.given_name, p.family_name, u.display_name as author_name
        from clinical_entry_versions v
        join clinical_entries ce on ce.id = v.entry_id and ce.current_version = v.version
        join patients p on p.id = v.patient_id join users u on u.id = v.author_id
       where v.patient_id = ${internal} and v.status in ('signed','amended','entered-in-error')
       order by v.occurred_at desc limit ${count} offset ${offset}
    `;
    const totalRows = await tx`
      select count(*)::int as count from clinical_entries ce join clinical_entry_versions v on v.entry_id = ce.id and ce.current_version = v.version
       where ce.patient_id = ${internal} and v.status in ('signed','amended','entered-in-error')
    `;
    return fhir(c, bundle(c, "DocumentReference", rows.map((row) => documentReferenceResource(row as Record<string, unknown>)), Number(totalRows[0]?.count ?? 0), offset, count));
  });
});

fhirRoutes.get("/fhir/r4/DocumentReference/:id", async (c) => {
  const id = c.req.param("id");
  return runFhir(c, async (tx) => {
    const rows = await tx`
      select v.*, p.public_id, p.given_name, p.family_name, u.display_name as author_name
        from clinical_entry_versions v join patients p on p.id = v.patient_id join users u on u.id = v.author_id
       where v.id = ${id} limit 1
    `;
    if (!rows[0]) throw new NotFoundError("DocumentReference not found");
    return fhir(c, documentReferenceResource(rows[0] as Record<string, unknown>));
  });
});

fhirRoutes.get("/fhir/r4/Provenance", async (c) => {
  rejectUnsupportedParams(c, ["patient", "subject", "_count", "_offset"]);
  const { count, offset } = pagination(c);
  const reference = publicPatientId(c);
  if (!reference) return fhir(c, operationOutcome("error", "invalid", "A patient/subject constrained search is required"), 400);
  return runFhir(c, async (tx, actor) => {
    const internal = await patientInternalId(tx, reference, actor);
    const rows = await tx`
      select v.*, p.public_id, p.given_name, p.family_name, u.display_name as author_name
        from clinical_entry_versions v join patients p on p.id = v.patient_id join users u on u.id = v.author_id
       where v.patient_id = ${internal} and v.status in ('signed','amended','entered-in-error')
       order by v.recorded_at desc limit ${count} offset ${offset}
    `;
    return fhir(c, bundle(c, "Provenance", rows.map((row) => provenanceResource(row as Record<string, unknown>)), rows.length, offset, count));
  });
});

fhirRoutes.get("/fhir/r4/Provenance/:id", async (c) => {
  const id = c.req.param("id");
  return runFhir(c, async (tx) => {
    const rows = await tx`
      select v.*, p.public_id, p.given_name, p.family_name, u.display_name as author_name
        from clinical_entry_versions v join patients p on p.id = v.patient_id join users u on u.id = v.author_id
       where v.id = ${id} limit 1
    `;
    if (!rows[0]) throw new NotFoundError("Provenance not found");
    return fhir(c, provenanceResource(rows[0] as Record<string, unknown>));
  });
});

fhirRoutes.get("/fhir/r4/Consent", async (c) => {
  rejectUnsupportedParams(c, ["patient", "_count", "_offset"]);
  const { count, offset } = pagination(c);
  return runFhir(c, async (tx, actor) => {
    const rows = actor.patientId
      ? await tx`
          select g.*, p.public_id from exchange_grants g join patients p on p.id = g.patient_id
           where g.patient_id = ${actor.patientId} order by g.created_at desc limit ${count} offset ${offset}
        `
      : await tx`
          select g.*, p.public_id from exchange_grants g join patients p on p.id = g.patient_id
           where g.recipient_tenant_id = ${actor.tenantId} order by g.created_at desc limit ${count} offset ${offset}
        `;
    return fhir(c, bundle(c, "Consent", rows.map((row) => consentResource(row as Record<string, unknown>)), rows.length, offset, count));
  });
});

fhirRoutes.get("/fhir/r4/Consent/:id", async (c) => {
  const id = c.req.param("id");
  return runFhir(c, async (tx, actor) => {
    const rows = actor.patientId
      ? await tx`select g.*, p.public_id from exchange_grants g join patients p on p.id = g.patient_id where g.id = ${id} and g.patient_id = ${actor.patientId}`
      : await tx`select g.*, p.public_id from exchange_grants g join patients p on p.id = g.patient_id where g.id = ${id} and g.recipient_tenant_id = ${actor.tenantId}`;
    if (!rows[0]) throw new NotFoundError("Consent not found");
    return fhir(c, consentResource(rows[0] as Record<string, unknown>));
  });
});

fhirRoutes.get("/fhir/r4/AuditEvent", async (c) => {
  rejectUnsupportedParams(c, ["patient", "subject", "_count", "_offset"]);
  const { count, offset } = pagination(c);
  return runFhir(c, async (tx, actor) => {
    const governance = actor.roles.includes("facility_admin") || actor.roles.includes("auditor");
    if (!actor.patientId && !governance) throw new ForbiddenError("AuditEvent access is restricted to governance roles");
    const reference = publicPatientId(c);
    let rows;
    if (actor.patientId) {
      if (reference && reference !== (await tx`select public_id from patients where id = ${actor.patientId}`)[0]?.publicId) throw new NotFoundError("AuditEvent not found");
      rows = await tx`select * from audit_events where subject_patient_id = ${actor.patientId} order by occurred_at desc limit ${count} offset ${offset}`;
    } else {
      const internal = reference ? await patientInternalId(tx, reference, actor) : null;
      rows = internal
        ? await tx`select * from audit_events where tenant_id = ${actor.tenantId} and subject_patient_id = ${internal} order by occurred_at desc limit ${count} offset ${offset}`
        : await tx`select * from audit_events where tenant_id = ${actor.tenantId} order by occurred_at desc limit ${count} offset ${offset}`;
    }
    return fhir(c, bundle(c, "AuditEvent", rows.map((row) => auditEventResource(row as Record<string, unknown>)), rows.length, offset, count));
  });
});

fhirRoutes.get("/fhir/r4/AuditEvent/:id", async (c) => {
  const id = c.req.param("id");
  return runFhir(c, async (tx, actor) => {
    const governance = actor.roles.includes("facility_admin") || actor.roles.includes("auditor");
    if (!actor.patientId && !governance) throw new ForbiddenError("AuditEvent access is restricted to governance roles");
    const rows = actor.patientId
      ? await tx`select * from audit_events where id = ${id} and subject_patient_id = ${actor.patientId}`
      : await tx`select * from audit_events where id = ${id} and tenant_id = ${actor.tenantId}`;
    if (!rows[0]) throw new NotFoundError("AuditEvent not found");
    return fhir(c, auditEventResource(rows[0] as Record<string, unknown>));
  });
});

fhirRoutes.all("/fhir/r4/*", (c) => fhir(c, operationOutcome("error", "not-found", "FHIR interaction is not implemented"), 404));
