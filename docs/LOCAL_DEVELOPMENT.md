# Local development

## Prerequisites

- Node.js >= 22.12 and npm.
- PostgreSQL 14+ reachable at `localhost:5432`.
- Playwright Chromium: `npx playwright install chromium`.

## First run

```bash
cp .env.example .env       # if .env is absent; replace every secret
npm install
npm run db:setup           # roles + medveris_dev database
npm run db:migrate
npm run db:seed
npm run dev                # API :8787 + web app :5173
```

Open <http://localhost:5173>.

Smoke accounts use password `Medveris!2026`:

- `clinician@medveris.local` — clinician, Kampala
- `admin@medveris.local` — facility administrator
- `reception@medveris.local` — receptionist
- `patient@medveris.local` — patient portal
- `nurse@medveris.local`, `clinician.b@medveris.local`, `reviewer@medveris.local`

Staff accounts require TOTP. In local development, click **Use local development code** on the MFA screen, or query:

```bash
curl 'http://localhost:8787/api/v1/auth/totp/dev?email=clinician@medveris.local'
```

`DEV_SHOW_TOTP_SECRETS=true` enables that endpoint. It is refused in production.

The MFA screen also offers **Email me a code instead** (delivered through the configured email provider; locally it lands in the mail sink) and **Use a recovery code**.

## Services

| Process | Command | Port |
|---|---|---|
| API | `npm run dev:api` | 8787 |
| Web (Vite proxy `/api`, `/fhir`, `/terminology`) | `npm run dev:web` | 5173 |
| Both | `npm run dev` | 8787 + 5173 |
| Jobs one cycle | `npm run jobs:once` | — |
| Jobs loop | `npm run jobs:watch` | — |
| Synthetic PACS (DICOMweb) | `npm run pacs:mock` | 8042 |

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e          # starts both dev servers unless already running
npm run smoke:clinical    # requires API on :8787; creates a synthetic note
npm run smoke:workers
npm run build
```

## Database reset

Stop the API, worker, tests and any `psql` sessions first. The reset command refuses production, non-synthetic database names and missing confirmation.

```bash
npm run db:reset:synthetic -- --check   # preflight only; changes nothing
npm run db:reset:synthetic -- --yes
```

Then restart the dev servers. Before any destructive step the command verifies that it is connected to the target database as `medveris_migrator`, that neither the migration nor runtime roles are SUPERUSER or BYPASSRLS, that `medveris_migrator` owns the `app` and `public` schemas, and that no other sessions are connected. It then drops and recreates both schemas and applies every migration in a single transaction, checks the RLS policies, helper functions and audit trigger, and commits only if all of that succeeds. Seeding runs afterwards as the runtime role in its own transaction.

On PostgreSQL 14 and earlier, `public` is created owned by `postgres`. `npm run db:setup` transfers it to `medveris_migrator`; run it once before the first reset.

`npm run db:migrate` fails if `schema_migrations` is current but helper functions, RLS policies or the audit immutability trigger are missing. That state needs a reset rather than more migrations.

## Configuration

Important `.env` values:

- `DATABASE_URL` — runtime role (`medveris_runtime`).
- `JOBS_DATABASE_URL` — jobs role (`medveris_jobs`).
- `MIGRATION_DATABASE_URL` — migration role (`medveris_migrator`).
- `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`, `AUDIT_SIGNING_KEY` — at least 24 characters each.
- `APP_ORIGIN` — public web origin, default `http://localhost:5173`.
- `TERMINOLOGY_MODE=synthetic` — required locally; production needs a provider URL and licence.
- `FHIR_EXTERNAL_WRITES_ENABLED=false`, `FHIR_BULK_EXPORT_ENABLED=false`.
- `CONTENT_FEEDS_ENABLED` — defaults to `false`. When `true`, the jobs runner (`npm run jobs:once` or `npm run jobs:watch`) and the staging cron import public news, outbreak alerts and funding calls from the official sources seeded by migration 027. Tests never fetch these feeds.
- Feature flags for lab, pharmacy, telemedicine, devices, AI, public health and ledger must stay false unless implemented and accepted.
- `FEATURE_DICOMWEB=true` plus `DICOMWEB_BASE_URL`/`DICOMWEB_AUTH` enables PACS review. Run `npm run pacs:mock`, configure `.env`, then verify as a platform operator in **Platform → Integrations**. Full workflow: `docs/22_PACS_DICOMWEB_RUNBOOK.md`.

Do not commit `.env`, `.data/`, `.mail-sink/`, `dist/` or test artifacts.
