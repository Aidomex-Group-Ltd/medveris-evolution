# Phase 1A — Generalized Dual Authorization Framework (Design Only)

Status: **design/proposal for owner review**. Not activated for all operations in Phase 1A.

## 1. Purpose
Provide a reusable, auditable request → independent review → execute workflow for designated high-risk operations requiring separation of duties (four-eyes). Backend enforcement is authoritative; UI cannot bypass or self-approve.

## 2. Core entities (proposed, additive)

### 2.1 `authorization_requests` (or equivalent domain-specific request records)
- `id` (uuid, pk)
- `tenant_id` (nullable for platform-scope requests; must match operation scope)
- `operation_key` (stable identifier, e.g. `finance.payment.reverse`, `membership.privilege.grant`)
- `resource_type`, `resource_id`
- `scope` (jsonb: tenant/organization/department/unit/patient as applicable)
- `requested_by_user_id`
- `requested_at`
- `request_reason` (required, length-bounded)
- `payload_digest` / immutable `request_payload` snapshot (minimal necessary, no secrets/PHI leakage)
- `status` (`pending` | `approved` | `rejected` | `cancelled` | `expired` | `executed` | `failed`)
- `required_approvals` (int/policy reference)
- `expires_at`
- `correlation_id`, `idempotency_key`

### 2.2 `authorization_decisions`
- `id`, `request_id`
- `decided_by_user_id`
- `decision` (`approve` | `reject` | `cancel`)
- `decision_reason`
- `decided_at`
- unique constraint preventing duplicate active decisions per actor/policy where applicable

### 2.3 `authorization_executions`
- `id`, `request_id`
- `executed_by_user_id` (system or authorized executor per policy)
- `executed_at`
- `result_status`, `result_reference`, `before_state`, `after_state` (or immutable refs/digests)
- `error_code` (if failed)

## 3. Workflow rules
- **Requester:** authenticated, authorized to request operation, tenant/scope-bound.
- **Approver:** authenticated, authorized to approve `operation_key`, **must not be requester** (and must not violate operation-specific conflicts, e.g. nominee/self-benefit/original actor of financial event where policy requires).
- **Execution:** only after required approvals, before expiry, request not cancelled/rejected/executed; operation payload must match approved snapshot/digest.
- **Idempotency:** repeated execute/replay calls must not duplicate side effects; use idempotency key + execution record + domain constraints.
- **States/transitions:** `pending -> approved|rejected|cancelled|expired`; `approved -> executed|failed|expired` (policy-defined). All transitions append-only/audited.
- **RLS/DB integrity:** tenant-scoped rows protected by RLS; platform-scope operations explicitly modeled and restricted.

## 4. Audit linkage
For each transition record:
- initiating user, approving user(s), executor (if applicable)
- timestamp, operation, affected resource, tenant/organization scope
- request/decision/execution IDs and correlation ID
- previous/new state or immutable digests/references
- approval status/reason, rejection/cancellation/expiry reason
- hash-chained audit event/outbox emission consistent with existing audit architecture

## 5. Emergency exception design (for owner/governance definition)
- **Not self-defining:** exceptions, eligible roles, and post-hoc review requirements must be approved by owner/clinical governance.
- Proposed pattern: allow explicitly enumerated emergency operations to execute under existing break-glass/emergency controls with mandatory justification, MFA, time-bound scope, enhanced audit, and compulsory retrospective review/attestation; never bypass identity, tenant isolation, or audit.
- Candidate examples for review only: emergency clinical access already governed by break-glass; **financial or privilege-escalation operations should default to no emergency bypass** unless explicitly approved.

## 6. Candidate high-risk operations (owner review required)
| Domain | Operation examples | Current evidence | Dual-auth recommendation |
|---|---|---|---|
| Finance | payment reversal/refund, invoice void, billing waiver/write-off/adjustment, payout/payroll release (future), significant price/config changes | targeted self-action SoD guards in `routes/finance.ts` | strong candidate; define thresholds/approvers |
| Clinical/sensitive records | record merge/unmerge, sensitive amendment/redaction/entered-in-error beyond normal flow, protected disclosure/export actions | merge/clinical flows exist; generalized dual control unverified | candidate subject to clinical/privacy governance |
| Privileged access | platform operator grant/revoke (partially controlled), facility role/privilege escalation, security/integration credential issuance, high-risk admin config | platform role workflows and admin checks exist | candidate/extend existing controls |
| Subscription/platform | forced entitlement/override/suspension with financial or access impact | platform billing routes exist | candidate for platform governance |

## 7. Decisions requiring owner approval (must not be invented)
- Exact operation keys in scope and per-tenant vs platform applicability.
- Required approver roles/permissions and count per operation.
- Monetary or sensitivity thresholds triggering dual approval.
- Expiry durations and SLA/escalation behavior.
- Whether requester can execute after approval.
- Emergency exceptions and post-hoc review obligations.
- UI/notification workflow and operational runbooks.

## 8. Phase 1A implementation boundary
- Delivered: design, candidate inventory, audit/state requirements, compatibility considerations.
- Not delivered: generalized schema/migrations, runtime enforcement activation for all operations, or approval thresholds/roles beyond design placeholders requiring owner decision.
