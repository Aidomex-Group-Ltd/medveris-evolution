# Subscription checkout FX rate source (USD/UGX)

**Correlation context:** checkout pricing errors return/support reference via `correlationId`; technical reasons are logged as structured `subscription_fx_rate` events (outcomes include `provider_fresh`, `provider_failed`, `provider_stale`, `provider_unconfigured`, `cache_used`, `cache_stale`, `manual_fallback`, `manual_expired_or_stale`, `manual_missing`, `unavailable`) with `correlationId` when available. Never log provider API keys.

## Variables

| Name | Kind | Default | Purpose / where |
|---|---|---|---|
| `FX_PROVIDER` | var/config | `none` | `openexchangerates` enables provider fetch; else provider unused. Set in `.env` / Worker var. |
| `FX_API_KEY` | **secret** | unset | OpenExchangeRates key (`app_id`). `wrangler secret put FX_API_KEY --env <staging|production>`. Never logged/stored. |
| `FX_TIMEOUT_MS` | var/config | `8000` | Provider timeout (1000–30000ms), used with retries. |
| `FX_MAX_AGE_HOURS` | var/config | `24` | Max age (1–168h) for any usable rate (provider timestamp / cache / manual `set_at`). Older refused. Back-compat: if unset, `SUBSCRIPTION_FX_MAX_AGE_MINUTES/60` is accepted. |
| `SUBSCRIPTION_MIN_UGX` | var/config | `500` | Minimum UGX collection. |
| `SUBSCRIPTION_PRODUCT_DESCRIPTION` | var/config | default text | Disclosed product name. |

## Sources & behavior
1. **Provider fetch** (`FX_PROVIDER=openexchangerates` + `FX_API_KEY`): fetch with timeout+retries, require freshness ≤ `FX_MAX_AGE_HOURS`, upsert cache into `subscription_fx_rates(base,quote,rate,provider,provider_timestamp,fetched_at)`.
2. **Cached provider rate**: used if fresh (≤ `FX_MAX_AGE_HOURS` from `provider_timestamp`).
3. **Manual DB rate fallback** (only if provider unset/failed/unusable): latest non-expired row in `subscription_fx_manual_rates(base,quote,rate,set_by,set_at,expires_at,note)` where `expires_at>now` and `set_at` within `FX_MAX_AGE_HOURS`.
4. **None valid:** fail closed — no UGX price shown, no payment requested; plain user message includes support/correlation reference. No hardcoded fallback rate.

## Quote lock & rounding
- `usdMinorToUgx(amountUsdMinor, ugxPerUsd)` (`packages/domain/src/subscription-interval.ts`) is the single rounding function (`Math.ceil` to whole UGX).
- Checkout stores `amount_ugx`, `fx_rate`, `fx_source`, `fx_provider_timestamp`, `fx_recorded_at`, `fx_rounding` on `subscription_checkouts` and charges the stored `amount_ugx`; later rate changes do not affect a locked checkout.

## Manual rate (operator, DB)
Insert a row into `subscription_fx_manual_rates` (system/operator DB path), e.g.:
`insert into subscription_fx_manual_rates(id,base,quote,rate,set_by,set_at,expires_at,note) values (gen_random_uuid(),'USD','UGX',<rate>,<operator_user_uuid>,now(),now()+interval '12 hours','reason');`
Only usable while non-expired and within `FX_MAX_AGE_HOURS` of `set_at`, and only as fallback.

## Migration
- `packages/db/migrations/136_subscription_fx_rates.sql` (additive: `subscription_fx_rates`, `subscription_fx_manual_rates`).
