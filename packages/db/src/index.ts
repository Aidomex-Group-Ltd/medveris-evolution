import postgres from "postgres";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

export interface TenantContext {
  tenantId?: string | null;
  userId?: string | null;
  patientId?: string | null;
  actorKind: "anonymous" | "registration" | "staff" | "patient" | "system";
  roles?: string[];
  platformRole?: string | null;
}

export function createSql(url: string, options: { max?: number; prepare?: boolean } = {}): Sql {
  return postgres(url, {
    max: options.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: options.prepare ?? true,
    onnotice: () => undefined,
    transform: postgres.camel,
  });
}

export function tenantSqlUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  return url;
}

export async function setLocalContext(tx: Tx, ctx: TenantContext): Promise<void> {
  const roles = (ctx.roles ?? []).join(",");
  await tx`
    select
      set_config('app.tenant_id', ${ctx.tenantId ?? ""}, true),
      set_config('app.user_id', ${ctx.userId ?? ""}, true),
      set_config('app.patient_id', ${ctx.patientId ?? ""}, true),
      set_config('app.actor_kind', ${ctx.actorKind}, true),
      set_config('app.roles', ${roles}, true),
      set_config('app.platform_role', ${ctx.platformRole ?? ""}, true)
  `;
}

export async function withContext<T>(sql: Sql, ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await setLocalContext(tx, ctx);
    return fn(tx);
  }) as Promise<T>;
}

export async function withAnonymous<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await setLocalContext(tx, { actorKind: "anonymous" });
    return fn(tx);
  }) as Promise<T>;
}

export async function withRegistration<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await setLocalContext(tx, { actorKind: "registration" });
    return fn(tx);
  }) as Promise<T>;
}
