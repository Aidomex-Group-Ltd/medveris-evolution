/**
 * Canonical authorization matrix — modularized.
 *
 * This is the authoritative source of truth for protected API actions.
 * It is the single source of entries re-exported from `packages/authz/src/matrix.ts`
 * for backward compatibility. Do not import from both this path and the compat
 * facade simultaneously.
 */
export * from "./types/index.js";
export * from "./version/index.js";
export { AUTHORIZATION_MATRIX } from "./actions/index.js";
export { NON_PERMISSION_ENDPOINTS } from "./exemptions/index.js";
export {
  MATRIX_BY_KEY,
  isKnownMatrixPermission,
  isKnownMatrixAction,
  getMatrixEntry,
  matrixEntriesForDomain,
  matrixEntriesForRouteFile,
  matrixEntriesForPermission,
  matrixDualAuthorizationCandidates,
  matrixUnresolvedActions,
} from "./lookup/index.js";
export { decideAction, assertMatrixAuthorized, MatrixDeniedError } from "./decision/index.js";
export type { MatrixDecision } from "./decision/index.js";
