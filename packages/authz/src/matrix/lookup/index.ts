/**
 * Matrix lookup helpers — modularized.
 *
 * Preserves the exact same function signatures and behavioral contracts
 * as the original implementations in packages/authz/src/matrix.ts.
 */

import type { MatrixEntry } from "../types/index.js";
import type { ResourceDomain } from "../../contract.js";
import type { Permission } from "../../permissions.js";
import { PERMISSIONS } from "../../permissions.js";
import { AUTHORIZATION_MATRIX } from "../actions/index.js";

export const MATRIX_BY_KEY: ReadonlyMap<string, MatrixEntry> = new Map(
  AUTHORIZATION_MATRIX.map((entry) => [entry.key, entry]),
);

const KNOWN_MATRIX_PERMISSIONS: ReadonlySet<string> = new Set(PERMISSIONS);

/** Runtime guard: true only for canonical permissions referenced by the matrix. */
export function isKnownMatrixPermission(value: string): value is Permission {
  return KNOWN_MATRIX_PERMISSIONS.has(value);
}

export function isKnownMatrixAction(key: string): boolean {
  return MATRIX_BY_KEY.has(key);
}

export function getMatrixEntry(key: string): MatrixEntry | undefined {
  return MATRIX_BY_KEY.get(key);
}

export function matrixEntriesForDomain(domain: ResourceDomain): readonly MatrixEntry[] {
  return AUTHORIZATION_MATRIX.filter((entry) => entry.domain === domain);
}

export function matrixEntriesForRouteFile(routeFile: string): readonly MatrixEntry[] {
  return AUTHORIZATION_MATRIX.filter((entry) => entry.routeFile === routeFile);
}

export function matrixEntriesForPermission(permission: Permission): readonly MatrixEntry[] {
  return AUTHORIZATION_MATRIX.filter((entry) => entry.permission === permission);
}

export function matrixDualAuthorizationCandidates(): readonly MatrixEntry[] {
  return AUTHORIZATION_MATRIX.filter((entry) => entry.dualAuthorizationCandidate === true);
}

export function matrixUnresolvedActions(): readonly MatrixEntry[] {
  return AUTHORIZATION_MATRIX.filter((entry) => entry.status === "unresolved");
}
