/**
 * Compatibility facade for the modularized authorization matrix.
 *
 * This file re-exports the public API from the modular matrix structure
 * at `packages/authz/src/matrix/`. Existing imports must continue working
 * without change.
 *
 * Do not import from both this facade and `packages/authz/src/matrix/` directly.
 */
export {
  AUTHORIZATION_MATRIX,
  AUTHORIZATION_MATRIX_VERSION,
  NON_PERMISSION_ENDPOINTS,
  MATRIX_BY_KEY,
  MatrixDeniedError,
  assertMatrixAuthorized,
  decideAction,
  getMatrixEntry,
  isKnownMatrixAction,
  isKnownMatrixPermission,
  matrixDualAuthorizationCandidates,
  matrixEntriesForDomain,
  matrixEntriesForPermission,
  matrixEntriesForRouteFile,
  matrixUnresolvedActions,
} from "./matrix/index.js";
export type {
  AuthorizationScope,
  MatrixDecision,
  MatrixEnforcement,
  MatrixEntry,
  MatrixRequirement,
  MatrixStatus,
  NonPermissionEndpoint,
} from "./matrix/index.js";
