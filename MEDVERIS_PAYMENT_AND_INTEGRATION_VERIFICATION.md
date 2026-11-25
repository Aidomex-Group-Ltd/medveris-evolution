# MedVeris — Payment and Integration Verification

- **Date:** 2026-11-25
- **Repo:** `/home/aidomex/medveris`

## Findings
- Production/staging: `PAYMENT_PROVIDER=livepay`; `FEATURE_PAYMENTS=false`; LivePay primary; Yo! disabled.
- LivePay secrets declared in wrangler (API key, webhook secret); `LIVEPAY_ACCOUNT_NUMBER` persisted as `LP2610311719`; `LIVEPAY_BASE_URL` set.
- `PAY-001` open: adapter/gate/config alignment and live verification pending.

## Disposition
Live verification cannot be claimed; `FEATURE_PAYMENTS=false` remains until live verification passes.
