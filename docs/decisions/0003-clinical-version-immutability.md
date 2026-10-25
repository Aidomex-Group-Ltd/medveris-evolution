# ADR 0003: Immutable signed versions with reasoned amendments

- Status: accepted for M1
- Date: 25 October 2026

## Context

Clinical notes must preserve what was signed and why it changed. In-place edits destroy provenance; hard deletion is unacceptable for a clinical record.

## Decision

Store every state in `clinical_entry_versions`. A draft can become signed in place once; the trigger rejects other mutations. Amendments create a new version with `previous_version_id`, a mandatory reason and a new signature. Entered-in-error is a new status, never a deletion. Digests and HMAC signatures bind content, author, time and version.

## Consequences

- Full signed history remains queryable and independently verifiable.
- Corrections require explicit reasons and create additional versions.
- Signing needs narrowly granted UPDATE privilege; migration 002 adds exactly that.
