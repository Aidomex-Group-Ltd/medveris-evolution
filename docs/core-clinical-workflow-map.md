# Core Clinical Workflow Map

**Date:** 2026-11-06
**References:** `apps/api/src/services/clinical.ts`, `apps/api/src/routes/clinical.ts`,
`apps/api/src/routes/reception.ts`

## End-to-end patient journey

1. **Check-in / registration** — `reception` route records the patient
   encounter and prepares the patient for a clinical encounter; the patient
   is the subject of every subsequent record in that encounter.
2. **Triage** — the triage author records the presenting complaint, urgency,
   and any observations, then **completes triage**.
3. **Complete triage** — `*completeTriage` persists the completed triage
   record and advances the encounter into `in-progress`. This is the
   **prerequisite** that unlocks documentation: clinical notes may only be
   created once an encounter has been triaged.
4. **Clinician documentation** — once `in-progress`, an authorized clinician
   documents the encounter.
5. **Signing** — the signed version carries an
   `recordProfessionalDesignation` snapshot so the title/speciality is
   immutable per signing event.

## `completeTriage` behavior (the handoff step)

- Inserts a `triage_records` row carrying `nurse_user_id`.
- For each observation ID supplied: updates `clinical_entries` to
  `in-progress` and sets `clinician_user_id =
  coalesce(clinician_user_id, nurseUserId)` — the nurse who triaged
  becomes the clinician of record.
- Advances `encounters` to `state = in-progress` and bumps `version`.
- Moves the open encounter off the nurse queue: `queue_entries` set to
  `status = 'with-clinician'` (excluding already-completed/cancelled).
- Emits an audit event (`encounter.triaged`) and an outbox event
  (`encounter.triaged`) for downstream delivery.

## Control flow that must hold

```text
registration → triage → completeTriage → clinician documents → sign
```

The `in-progress` state transition is the inverted gate: **no
`in-progress` encounter → no signed clinical note**.

## Related files

| Concept | File |
|---|---|
| Triage completion | `apps/api/src/services/clinical.ts` |
| Signing authorization | `apps/api/src/routes/clinical.ts` |
| Professional designation snapshot | `apps/api/src/services/clinical.ts` (`recordProfessionalDesignation`) |
| Directory provider data | `apps/api/src/routes/directory.ts` (`/directory/providers`) |
| Pricing subscriptions | `apps/api/src/routes/subscription-checkout.ts`, `packages/db/migrations/035_pricing_subscriptions_usage.sql` |
