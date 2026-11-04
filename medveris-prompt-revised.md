# MEDVERIS — UNIFORM PLATFORM SERVICES, CAPACITY-BASED PRICING & CLOUDFLARE WORKERS AI ACTIVATION

You are working in the Medveris monore(repo) as a senior SaaS architect, Cloudflare Workers engineer, healthcare software engineer, and database engineer.

Your assignment is to establish a uniform Medveris platform in which every subscribed customer receives the same core services, AI capabilities, and advanced analytics.

The only differences between subscription packages must be:

1. Number of staff accounts permitted.
2. Included storage capacity.

You must also investigate, configure, and activate Cloudflare Workers AI as the platform's AI infrastructure.

## CONTEXT YOU MUST RESPECT BEFORE EDITING

This repository already has:

- A **platform feature-flag / integration-registry model** (`FEATURE_*` env vars, `apps/api/src/integrations/registry.ts`, integration states `available/degraded/unavailable/disabled/not_requested/misconfigured/verification_failed`). AI is already registered there as the `"ai"` integration with baseline "No validated model, intended-use statement or clinical evaluation is approved".
- A **subscription / billing model** built around `subscription_plans` (codes `trial`, `basic`, `standard`, `advanced`, `enterprise`), `plan_resource_rules` over `usage_resources`, and a platform billing console (`/platform/billing/*`). The public pricing page and the platform billing page are editable; the authoritative plan model is the database + platform billing APIs.
- An **in-progress centralized AI package** `@medveris/ai` (`packages/ai/...`) with `runAi(...)`, `normalizeAiUsage(...)`, and types. The API layer has `apps/api/src/lib/ai.ts` exporting `AI_MODEL_CONFIG`, `aiDependencies(...)`, `runClinicalAi(...)`, and an unexported `buildClinicalPrompt(...)`. The route `apps/api/src/routes/ai.ts` creates `ai_jobs` through the clinical write gate.
- A **Wrangler configuration** (`wrangler.jsonc`) with Hyperdrive, R2, Durable Objects, Queues, etc., but **no Workers AI binding yet** and `FEATURE_AI: "false"` in production staging vars.
- A **clinical AI job table** `ai_jobs` (migration `004`) and AI-job schema `aiJobSchema` in `@medveris/contracts`.

Do not assume a feature exists because it appears in the frontend.

Produce a concise findings report and implementation plan before modifying files.

Preserve unrelated user changes.

## STEP 0 — INVESTIGATE BEFORE MODIFYING

Before making changes:

1. Inspect the Git branch, working tree, recent commits, and uncommitted modifications.
2. Review the existing pricing implementation: `subscription_plans`, `plan_resource_rules`, `usage_resources`, the platform billing console APIs, and the public pricing page.
3. Inspect subscription and billing database migrations (especially `035_pricing_subscriptions_usage.sql`), and confirm whether any migration already treats AI as a billable resource or a plan feature gate.
4. Review pricing APIs, subscription services (`apps/api/src/services/subscriptions.ts`), entitlement/billing middleware (`apps/api/src/lib/billing-middleware.ts`), and platform administration (`/platform/billing/*`).
5. Inspect the current Cloudflare Workers configuration, including:
   - `wrangler.jsonc` (bindings, environments, vars, secrets required lists)
   - Worker entry points (`apps/api/src/worker.ts`, `apps/api/src/server.ts`)
   - Environment types (`apps/api/src/types.ts`, `AppBindings`, `AppDeps`)
   - Existing AI integrations (the `@medveris/ai` package and `apps/api/src/lib/ai.ts`)
   - Existing Cloudflare account configuration (account id, environments, secrets already required)
   - Development, staging, and production environments
6. Identify existing analytics, reporting, and AI-related services (reports, billing usage metering, `ai_jobs`).
7. Identify existing authentication, authorization, tenant isolation, audit logging, and data-protection mechanisms (RLS, `app.current_tenant()`, clinical write gate, audit writes, patient-link checks in the AI route).

Do not assume that a feature exists because it appears in the frontend.

Produce a concise findings report and implementation plan before modifying files.

Preserve unrelated user changes.

## STEP 1 — ESTABLISH THE UNIFORM PLATFORM MODEL

All subscription packages must receive identical access to:

- All core Medveris modules.
- AI-powered platform capabilities.
- Advanced analytics.
- Reporting and dashboards.
- Workflow automation.
- Notifications.
- Document and data-processing capabilities.
- Existing integrations available to the subscribed tenant.
- Platform improvements and new foundational capabilities.

Do not restrict these services according to subscription tier.

Do not introduce separate AI-enabled and AI-disabled subscription plans.

Do not introduce premium-only advanced analytics.

Do not charge an additional AI-seat fee.

The only package-based entitlements are **staff-account capacity** and **storage capacity**.

### 1.1 Respect the existing integration-registry gating for AI, but do not make it a plan gate

The platform already gates AI availability through the integration registry (`FEATURE_AI`, model validation / risk / privacy / clinical evaluation prerequisites). That is an **environment / compliance gate**, not a **subscription-tier gate**.

- A tenant on any approved plan must be able to use AI if the environment's AI integration is `available`.
- A tenant on any approved plan must be blocked from AI jobs in exactly the same way if the environment's AI integration is not `available`.
- Do not add plan-code checks around AI job creation, AI usage, or AI features.

## STEP 2 — AUTHORITATIVE PACKAGE DEFINITIONS

Use the following commercial definitions:

| Package | Monthly price | Staff accounts | Storage |
|---|---:|---:|---:|
| Basic | USD 15 | 10 | 10 GB |
| Standard | USD 30 | 50 | 50 GB |
| Professional | USD 100 | 250 | 200 GB |
| Enterprise | Configurable | Configurable | Configurable |

Additional rules:

- Patient accounts are free.
- Patient accounts must not consume staff-account allowances.
- AI is included in every package.
- Advanced analytics are included in every package.
- All core platform services are included in every package.
- The Enterprise package must support configurable commercial terms.
- The platform must retain the public package name **Professional**.
- Do not silently rename Professional to Advanced or another name.

Remove or revise any existing implementation that treats AI, analytics, or core platform functionality as paid tier-specific entitlements.

If the existing database contains separate AI-seat pricing or AI-specific package restrictions, identify and safely reconcile them.

Do not rewrite previously applied migrations. Use forward-only migrations where database changes are necessary.

### 2.1 Reconcile the existing `advanced` plan code with the required public name "Professional"

The existing schema already has the plan code `advanced`. Decide and document, consistently across:

- the public pricing page,
- the platform billing plans UI,
- and any backend plan metadata,

whether the public-facing name for the `advanced` code is "Professional" (preferred per this spec) while the internal code remains `advanced`, or whether a new forward-only plan row is warranted.

If a code/name mismatch is the cheapest safe path, prefer: keep code `advanced`, display name "Professional" wherever humans read it, and make the pricing page and billing UI agree.

Do not introduce both "Advanced" and "Professional" as separate public plans.

## STEP 3 — ENTITLEMENT ARCHITECTURE

Establish a clear separation between:

A. Platform feature availability.  
B. Subscription capacity limits.

All subscribed tenants must have the same platform feature entitlements.

The entitlement engine should enforce:

- Maximum staff accounts.
- Storage allowance.
- Enterprise-specific account and storage limits.
- Patient-account classification.
- Subscription status and payment requirements.

Staff-account capacity must be enforced on the backend when:

- Inviting a staff member.
- Activating an account.
- Reactivating a suspended account.
- Creating or provisioning staff accounts through administrative APIs.

Patient registration must remain free and must not be blocked by staff-account limits.

Prevent frontend-only entitlement enforcement.

Use database transactions or appropriate concurrency controls to prevent multiple simultaneous invitations from exceeding account limits.

### 3.1 Where the existing code already does part of this

The codebase already has:

- A `users.active` usage resource and `storage.file_bytes` usage resource.
- `plan_resource_rules` with `included / excluded / billable` treatments.
- A `subscriptionGuard()` middleware that pauses specific growth/analytics routes when a subscription is restricted (and explicitly never blocks patient records or care workflows).

Build the staff-account and storage capacity enforcement on top of this existing model rather than inventing a second entitlement system.

For staff accounts, the existing `users.active` resource is a daily snapshot of active staff memberships. Capacity enforcement must still be **hard and immediate** at invitation/activation/reactivation time, not only a post-hoc usage billing signal.

## STEP 4 — STORAGE MANAGEMENT

Implement or verify authoritative storage metering.

Requirements:

- Track tenant storage consumption accurately.
- Include applicable uploaded documents, attachments, images, and other stored customer files.
- Avoid double-counting files.
- Ensure storage calculations are tenant-isolated.
- Alert administrators at 80% and 90%.
- Clearly display usage and remaining capacity.
- Support future configurable storage add-ons if needed.
- Never automatically delete customer data because a tenant exceeds its storage allowance.

Define safe behavior when storage is exhausted. Existing records must remain accessible, while additional storage-consuming operations can be restricted or require an upgrade.

### 4.1 Align storage metering with the existing `storage.file_bytes` usage resource

The migration already defines `storage.file_bytes` as a `max`-aggregated daily snapshot of uploaded file bytes held for the workspace. Use that as the authoritative basis rather than recomputing storage from scratch in application code.

If the existing snapshot mechanism is incomplete, extend it with a forward-only change; do not replace the billing usage model.

## STEP 5 — CLOUDFLARE WORKERS AI ACTIVATION

Investigate and activate Cloudflare Workers AI as Medveris' foundational AI infrastructure.

Do not merely add an unused configuration entry. Establish a working, tested integration.

### 5.1 Cloudflare configuration

Inspect the existing Wrangler configuration and determine the correct configuration for Workers AI.

Where supported by the project's Cloudflare setup:

- Configure the Workers AI binding (`ai` binding in `wrangler.jsonc`).
- Update Worker environment types so `AppDeps` can carry the AI binding when present.
- Ensure local development can use the appropriate AI configuration.
- Configure staging and production environments separately.
- Preserve existing database, R2, authentication, and other bindings.
- Avoid committing API keys, secrets, or account credentials.

Use current Cloudflare Workers AI documentation and the installed Wrangler version to verify configuration compatibility.

### 5.2 Central AI service

Implement a reusable, centralized AI service rather than scattering direct model calls throughout application modules.

The service should provide:

- A consistent interface for AI operations.
- Model selection through configuration.
- Structured input and output handling.
- Input validation.
- Output validation.
- Timeouts.
- Error handling.
- Retry policies where appropriate.
- Usage tracking.
- Token or inference usage metadata where available.
- Logging and observability.
- Graceful fallback when AI is unavailable.

Do not hardcode model assumptions throughout the application.

Verify the availability, capabilities, limitations, and pricing of selected models before adopting them.

### 5.3 Converge the in-progress `@medveris/ai` package with the API layer

The repository already started this work:

- `@medveris/ai` exports `runAi(...)`, `normalizeAiUsage(...)`, and types.
- `apps/api/src/lib/ai.ts` imports from `@medveris/ai` and builds `AI_MODEL_CONFIG`, `aiDependencies(...)`, `runClinicalAi(...)`.

Finish the convergence cleanly:

- Make config-driven model selection real (`config.ai.*`), not a hidden constant.
- Make the clinical path a **consumer** of the central service, not a parallel implementation.
- Ensure `buildClinicalPrompt(...)` is either exported from the shared layer or intentionally local with a clear reason.
- Keep the AI route's existing clinical Write-gate, patient-link check, audit write, and disclaimer behavior.

### 5.4 Platform AI use cases

Identify existing workflows that can benefit from Workers AI and prioritize practical integrations.

Potential applications include:

- Intelligent search.
- Natural-language interaction with platform data.
- Operational reporting and summaries.
- Advanced analytics explanations.
- Document extraction and classification.
- Data entry assistance.
- Inventory and procurement insights.
- Administrative workflow assistance.
- Notification and communication assistance.
- Business intelligence support.

Integrate AI into existing application workflows rather than creating disconnected demonstration features.

Start with a small number of high-value, low-risk integrations and establish a reusable architecture for future capabilities.

### 5.5 Healthcare safety and privacy

Medveris handles sensitive healthcare and operational information.

Therefore:

- Enforce tenant isolation before AI requests are constructed.
- Apply least-privilege access to all retrieved data.
- Minimize sensitive information sent to models.
- Never allow a model to bypass application authorization.
- Do not expose one tenant's information to another tenant.
- Do not use AI as an autonomous diagnostic or prescribing authority.
- Require appropriate human review for clinical outputs.
- Log relevant AI operations without unnecessarily logging sensitive patient information.
- Investigate applicable Cloudflare data-processing, retention, and privacy requirements before sending protected data to Workers AI.
- Do not send sensitive patient data to a model until the data-handling and compliance requirements have been verified.

AI output must never be treated as trusted SQL, executable code, authorization policy, or a verified clinical fact.

Keep the existing AI-job disclaimer and the clinical-review-only framing already present in `apps/api/src/routes/ai.ts`.

### 5.6 Cost controls

AI is included in every package, but infrastructure costs must remain manageable.

Implement platform-wide operational controls, including:

- Request throttling.
- Abuse prevention.
- Configurable usage safeguards.
- Monitoring of inference costs.
- Model selection based on workload.
- Limits on excessive or repeated requests.
- Administrative visibility into aggregate AI usage.

These are platform reliability and cost controls, not subscription-tier feature restrictions.

Do not reintroduce AI seat charges or plan-specific AI entitlements.

Any customer-facing usage-based billing proposal must be presented separately for business approval. Do not implement it without authorization.

## STEP 6 — ADVANCED ANALYTICS

Ensure advanced analytics are part of the common platform foundation.

Inspect existing analytics and identify gaps.

AI should enhance analytics by providing explanations, summaries, insights, and natural-language exploration where appropriate.

However:

- Analytics calculations must remain grounded in authoritative application data.
- AI must not invent financial or operational figures.
- Users must only see data they are authorized to access.
- Reports must preserve tenant and facility boundaries.
- Critical financial and operational metrics must be calculated deterministically.

Do not make advanced analytics a Professional- or Enterprise-only feature.

## STEP 7 — BILLING AND ADMINISTRATION

Update the public pricing page, billing APIs, subscription services, and platform administration interface to reflect the unified package model.

Ensure:

- Public package names are correct (Basic, Standard, **Professional**, Enterprise).
- Prices and capacity limits agree across frontend and backend.
- AI and analytics are visibly included in every package.
- No AI-seat surcharge is displayed.
- Staff-account limits are clear.
- Storage allowances are clear.
- Enterprise configuration remains supported.
- Backend pricing remains authoritative.
- Administrative plan approval and versioning continue to work.

Do not let frontend-supplied prices determine payment amounts.

Preserve existing payment-provider verification and subscription activation safeguards.

### 7.1 Specifically fix the public pricing page's language

The public pricing page currently presents AI as a countable "AI seats" product with seat-priced language ("How AI seats are priced", per-plan AI seat counts, etc.). Revise it so that:

- AI is described as **included in every plan**, not as a seat-counted commodity.
- There is no AI-seat price, AI-seat overage, or AI-seat allowance shown as a commercial differentiator.
- The only differentiating quantities shown for non-Enterprise plans are **staff accounts** and **storage**.

Keep the page accurate to the backend: it may still be illustrative, but it must not contradict the uniform-platform model.

## STEP 8 — TESTING AND VERIFICATION

Add or update tests covering:

1. Identical feature access across all packages.
2. Basic staff-account limit.
3. Standard staff-account limit.
4. Professional staff-account limit.
5. Enterprise configurable limits.
6. Free patient accounts.
7. Patient accounts not consuming staff allowances.
8. Storage allowances.
9. Storage alerts.
10. No automatic customer-data deletion.
11. AI availability through the centralized service.
12. AI error handling and fallback.
13. AI tenant isolation.
14. AI authorization.
15. AI usage monitoring.
16. Analytics access across all packages.
17. Billing and pricing consistency.

Run relevant:

- Database migration checks.
- API tests.
- Service tests.
- Frontend tests.
- TypeScript checks.
- Production builds.

Do not claim a test passed unless it was actually executed.

## STEP 9 — CLOUDFLARE DEPLOYMENT READINESS

Verify the Workers AI integration in each relevant environment.

Distinguish clearly between:

- Local configuration complete.
- Local inference test passed.
- Staging configuration complete.
- Staging inference test passed.
- Production configuration complete.
- Production inference test passed.

Do not claim production activation merely because a Wrangler configuration file was modified.

Do not deploy, alter production secrets, or change production resources without explicit authorization.

If a Cloudflare account binding, account permission, environment variable, or external configuration requires manual action, provide the exact instructions and identify what remains blocked.

## STEP 10 — FINAL REPORT

Deliver:

1. Existing architecture findings.
2. Files changed.
3. Database changes and migration safety.
4. Revised package and entitlement architecture.
5. Verification that all packages have identical feature access.
6. Staff-account enforcement.
7. Patient-account treatment.
8. Storage metering and protection.
9. Cloudflare Workers AI configuration.
10. AI service architecture.
11. AI integrations completed.
12. Privacy and healthcare safeguards.
13. Analytics improvements.
14. Tests and build results.
15. Remaining manual Cloudflare configuration.
16. Deployment readiness.

Classify each item as:

- VERIFIED
- IMPLEMENTED AND TESTED
- PARTIALLY IMPLEMENTED
- NOT IMPLEMENTED
- BLOCKED
- REQUIRES BUSINESS DECISION

## EXECUTION RULES

- Investigate before editing.
- Preserve existing working functionality.
- Reuse existing architecture where appropriate (integration registry, subscription/usage model, clinical write gate, audit logging).
- Avoid duplicate billing, subscription, and entitlement systems.
- Never rewrite applied migration history.
- Do not silently change approved commercial terms.
- Do not expose secrets.
- Do not deploy or alter production without authorization.
- Do not claim Cloudflare Workers AI is active without a successful inference test in the relevant environment.
- Do not introduce "AI seats" as a commercial concept.

The desired result is a uniform Medveris healthcare platform where every customer receives the same powerful services, AI capabilities, and analytics, while subscription pricing scales only according to staff-account capacity and storage.
