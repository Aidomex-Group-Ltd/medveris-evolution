import { withContext, type Sql, type Tx } from "@medveris/db";
import { AppError } from "../lib/errors.js";

export interface WorkspaceCapacity {
  staffLimit: number | null;
  storageLimitBytes: number | null;
}

/**
 * Reads the active plan's staff and storage allowances. Plan metadata is read under a system context
 * because a department administrator may invite staff without holding billing access.
 */
export async function workspaceCapacity(sql: Sql, tenantId: string): Promise<WorkspaceCapacity> {
  const [row] = await withContext(sql, { actorKind: "system", tenantId }, (tx) => tx`
    select
      (select r.included_quantity from plan_resource_rules r
        where r.plan_id = s.plan_id and r.resource = 'users.active') as staff_limit,
      (select r.included_quantity from plan_resource_rules r
        where r.plan_id = s.plan_id and r.resource = 'storage.file_bytes') as storage_limit
      from subscriptions s
      join tenants t on t.billing_account_id = s.billing_account_id
     where t.id = ${tenantId} and s.status <> 'cancelled'
     order by s.created_at desc
     limit 1`);
  const staff = row?.staffLimit == null ? null : Number(row.staffLimit);
  const storage = row?.storageLimit == null ? null : Number(row.storageLimit);
  return {
    staffLimit: staff != null && Number.isFinite(staff) ? staff : null,
    storageLimitBytes: storage != null && Number.isFinite(storage) ? storage : null,
  };
}

export interface StaffSeatUsage {
  active: number;
  pending: number;
  limit: number | null;
}

/**
 * Counts occupied and reserved seats in one workspace. Pending invitations reserve a seat so several
 * simultaneous invitations cannot all pass the same free-seat check.
 */
export async function staffSeatUsage(
  tx: Tx,
  tenantId: string,
  limit: number | null,
  options: { excludeInvitationId?: string; excludeEmail?: string } = {},
): Promise<StaffSeatUsage> {
  const [row] = await tx`
    select
      (select count(*)::int from memberships m where m.tenant_id = ${tenantId} and m.status = 'active') as active,
      (select count(*)::int from invitations i
        where i.tenant_id = ${tenantId}
          and i.accepted_at is null and i.revoked_at is null and i.declined_at is null
          and i.expires_at > now()
          and (${options.excludeInvitationId ?? null}::uuid is null or i.id <> ${options.excludeInvitationId ?? null}::uuid)
          and (${options.excludeEmail ?? null}::text is null or lower(i.email) <> lower(${options.excludeEmail ?? null}))) as pending`;
  const active = Number(row?.active ?? 0);
  const pending = Number(row?.pending ?? 0);
  return { active, pending, limit };
}

/**
 * Refuses a new or reactivated staff seat when the workspace plan allowance is full. The caller must
 * hold the tenant row lock so the count and the subsequent membership write are serialised.
 */
export function assertStaffCapacity(usage: StaffSeatUsage, additional: number, planName?: string): void {
  if (usage.limit == null || additional <= 0) return;
  const occupied = usage.active + usage.pending;
  if (occupied + additional <= usage.limit) return;
  throw new AppError(
    409,
    "staff_capacity_reached",
    `${planName ? `${planName} allows` : "This plan allows"} ${usage.limit} active staff account${usage.limit === 1 ? "" : "s"} per workspace. Patient accounts remain free. Remove a staff member or upgrade the plan to invite more.`,
    { limit: usage.limit, active: usage.active, pending: usage.pending },
  );
}

/** Stored file bytes for one workspace, the same basis as the storage.file_bytes usage snapshot. */
export async function storedBytes(tx: Tx, tenantId: string): Promise<number> {
  const [row] = await tx`select coalesce(sum(size_bytes), 0)::bigint as bytes from uploads where tenant_id = ${tenantId}`;
  return Number(row?.bytes ?? 0);
}

export function assertStorageCapacity(used: number, incoming: number, limit: number | null): void {
  if (limit == null) return;
  if (used + incoming <= limit) return;
  throw new AppError(
    409,
    "storage_limit_reached",
    "This upload would exceed the workspace storage allowance. Existing records stay accessible; remove files or upgrade the plan to store more.",
    { limit, used, incoming },
  );
}
