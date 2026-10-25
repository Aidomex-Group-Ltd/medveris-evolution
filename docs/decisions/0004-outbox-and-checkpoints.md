# ADR 0004: Transactional outbox and signed checkpoints

- Status: accepted for M1
- Date: 25 October 2026

## Context

Side effects must not commit when their clinical transaction rolls back, and duplicate delivery must be harmless. Audit evidence needs tamper-evident summaries.

## Decision

Write audit, clinical changes and outbox rows in the same transaction. Jobs claim rows with `FOR UPDATE SKIP LOCKED`, deduplicate with a unique `(event_id, processor)` record, retry with exponential backoff and dead-letter after six attempts. Periodically compute per-tenant Merkle roots over audit event hashes and store them with HMAC signatures and monotonic batches. No blockchain or external ledger is used.

## Consequences

- At-least-once dispatch with idempotent processors.
- Local checkpoints prove internal consistency but not external immutability.
- A future anchoring adapter can consume the signed checkpoint without changing clinical transactions.
