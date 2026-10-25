# ADR 0001: Verify on Node/PostgreSQL before claiming edge deployment

- Status: accepted for M0/M1
- Date: 25 October 2026

## Context

The planning documents propose Cloudflare Workers, Hyperdrive, R2 and asynchronous queues. Local delivery needs an executable, testable system without pretending an edge deployment has been validated.

## Decision

Use Hono on Node with PostgreSQL as the verified local runtime. Keep a Worker entrypoint and produce a bundle, but do not claim Cloudflare readiness until Hyperdrive, R2, queue/cron and edge compatibility are tested. Local adapters (mail sink, filesystem storage) implement the same interfaces as the production adapters.

## Consequences

- Fast, reproducible local verification with real PostgreSQL RLS.
- Production deployment remains an explicit gap.
- Some runtime-specific behavior (connection pooling, storage, queues) must be re-tested at the target.
