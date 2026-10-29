import type { DatabaseRouter, ShardAssignment, ShardRouter, Sql } from "@medveris/db";
import type { Role } from "@medveris/authz";
import type { AppConfig } from "./config.js";
import type { DicomwebClient } from "./integrations/dicomweb.js";
import type { FetchLike } from "./integrations/dhis2.js";
import type { EmailAdapter } from "./lib/email.js";
import type { StorageAdapter } from "./lib/storage.js";
import type { RequestAnnotations } from "./lib/observability.js";
import type { RateLimiter } from "./lib/rate-limit.js";
import type { RealtimePublisher } from "./realtime/publisher.js";

export interface UserRecord {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  displayName: string;
  givenName: string;
  familyName: string;
  status: string;
  totpSecretEnc: string | null;
  mfaEnrolledAt: Date | null;
  createdAt: Date;
}

export interface SessionRecord {
  id: string;
  userId: string;
  csrfToken: string;
  activeTenantId: string | null;
  mfaVerifiedAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface MembershipRecord {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  roles: Role[];
  status: string;
  /** Shard directory entry for this facility; null when the directory has no row for it. */
  shard?: ShardAssignment | null;
  /** Department or unit that scoped roles on this membership are limited to. */
  scope?: MembershipScope;
}

export interface MembershipScope {
  departmentId: string | null;
  unitId: string | null;
}

export interface AuthContext {
  user: UserRecord;
  session: SessionRecord;
  memberships: MembershipRecord[];
  activeTenant: {
    id: string;
    name: string;
    slug: string;
    roles: Role[];
    membershipId: string;
    shard?: ShardAssignment | null;
    scope?: MembershipScope;
  } | null;
  patientId: string | null;
  platformRoles: string[];
  mfaVerified: boolean;
}

export interface AppDeps {
  /** Primary (read-write) connection. */
  sql: Sql;
  /** Read routing; absent means every read uses `sql`. */
  db?: DatabaseRouter;
  shards?: ShardRouter;
  rateLimiter?: RateLimiter;
  realtime?: RealtimePublisher;
  config: AppConfig;
  email: EmailAdapter;
  storage: StorageAdapter;
  /** PACS client; absent means one is built from `config.dicomweb` when it is fully configured. */
  dicomweb?: DicomwebClient | null;
  /** Transport for facility DHIS2 connections; tests inject a fake server. */
  dhis2Transport?: FetchLike;
}

export interface AppVariables {
  deps: AppDeps;
  auth: AuthContext | null;
  correlationId: string;
  annotations: RequestAnnotations;
}

/** Dependencies shared by every request; `sql` is omitted when each request binds its own client. */
export type AppBaseDeps = Omit<AppDeps, "sql"> & { sql?: Sql };

/** Outcomes the Worker reads back after the router returns, e.g. to drive the database breaker. */
export interface RequestState {
  databaseUnavailable: boolean;
}

export interface AppBindings {
  /** Per-request dependencies. Workers must not share database sockets between requests. */
  requestDeps?: AppDeps;
  requestState?: RequestState;
  /** Workers execution context, present only on Cloudflare; used for background cache writes. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export type AppEnv = { Bindings: AppBindings; Variables: AppVariables };
