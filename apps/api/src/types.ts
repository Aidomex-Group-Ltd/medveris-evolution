import type { Sql } from "@medveris/db";
import type { Role } from "@medveris/authz";
import type { AppConfig } from "./config.js";
import type { EmailAdapter } from "./lib/email.js";
import type { StorageAdapter } from "./lib/storage.js";

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
  } | null;
  patientId: string | null;
  platformRoles: string[];
  mfaVerified: boolean;
}

export interface AppDeps {
  sql: Sql;
  config: AppConfig;
  email: EmailAdapter;
  storage: StorageAdapter;
}

export interface AppVariables {
  deps: AppDeps;
  auth: AuthContext | null;
  correlationId: string;
}

export type AppEnv = { Variables: AppVariables };
