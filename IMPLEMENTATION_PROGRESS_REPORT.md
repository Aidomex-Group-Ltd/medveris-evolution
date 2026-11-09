# Medveris Ollama Integration — Preserve and Use Existing HTTP Basic Authentication

**Evidence-based report and implementation proposal**
Prepared: 2026-11-09

---

## 1. The actual existing Nginx Basic Auth configuration

### Source: VPS inspection via SSH (deploy@113.30.188.181, key `~/.ssh/medveris_kamatera`)

**Nginx virtual host** (`/etc/nginx/sites-enabled/ollama.medveris.online` → symlink to `/etc/nginx/sites-available/ollama.medveris.online`):

```nginx
server {
    server_name ollama.medveris.online;

    location /.well-known/acme-challenge/ { root /var/www/html; }

    location / {
        proxy_pass http://127.0.0.1:11434;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;

        auth_basic "Ollama restricted";
        auth_basic_user_file /etc/nginx/.htpasswd_ollama;
    }

    listen [::]:443 ssl ipv6only=on;
    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/ollama.medveris.online/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ollama.medveris.online/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

server {
    if ($host = ollama.medveris.online) {
        return 301 https://$host$request_uri;
    }
    listen 80;
    listen [::]:80;
    server_name ollama.medveris.online;
    return 404;
}
```

### Authentication details (verified on VPS)

| Item | Value |
|------|-------|
| Mechanism | `auth_basic` |
| Realm | `Ollama restricted` |
| Password file | `/etc/nginx/.htpasswd_ollama` |
| File ownership | `root:www-data` |
| File permissions | `640` (`-rw-r-----`) |
| File size | 45 bytes |
| File modified | 2026-11-08 02:29:10 UTC |
| Auth location | Inside the `location /` block, protecting all proxy traffic |
| Ollama private listener | `127.0.0.1:11434` (proxied via `proxy_pass`) |
| Ollama process | `/bin/ollama serve` running as root (PID 78764) |
| TLS | Let's Encrypt, managed by Certbot |

**No Bearer authentication is configured.** There is no `$http_authorization` mapping, no token file, no `auth_request` directive, and no token validation layer in the Nginx config. The only authentication mechanism is HTTP Basic Auth via `auth_basic_user_file`.

### Rate limiting

No rate-limiting configuration was found in the Ollama virtual host. The only directives are the proxy settings and Basic Auth.

---

## 2. The exact authentication behavior currently implemented by Medveris

### Code path: live Ollama provider

The application constructs the outbound request in `createLiveOllamaClient` (`apps/api/src/integrations/ollama.ts`):

```typescript
const response = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(settings.token ? { authorization: `Bearer ${settings.token}` } : {}),
  },
  body: JSON.stringify({ model, messages, stream: false, ... }),
  signal: controller.signal,
});
```

**The application sends `Authorization: Bearer <AI_TOKEN>` when `AI_TOKEN` is set.**

This is configured via `apps/api/src/config.ts`:

```typescript
export function aiConfig(env: EnvLike, appEnv: string): AiConfig {
  const rawUrl = (env.AI_BASE_URL ?? "").trim();
  let baseUrl: string | null = rawUrl || null;
  // ... URL validation (HTTPS required outside local/test) ...
  const token = (env.AI_TOKEN ?? "").trim() || null;
  return { baseUrl, token };
}
```

**The production and staging wrangler configs already set:**
- `AI_BASE_URL = "https://ollama.medveris.online"` (production `vars`; also present as staging `secret_text`)
- `AI_TOKEN` listed in `secrets.required` for production and as `secret_text` for staging

### What the application does NOT do

The application does **not** support HTTP Basic Authentication. There is no code path that constructs an `Authorization: Basic` header from a username and password. The only authentication header construction is:

```typescript
authorization: `Bearer ${settings.token}`
```

The `OllamaSandboxConfig` / `createOllamaClient` path (sandbox/local dev) sends no `Authorization` header at all.

### Settings passed to the live client

From `apps/api/src/lib/ai.ts`:

```typescript
const client = createLiveOllamaClient({
  baseUrl: deps.config.ai.baseUrl,   // "https://ollama.medveris.online"
  token: deps.config.ai.token,       // AI_TOKEN secret value
  model: deps.config.aiModel.model,  // AI_MODEL
  timeoutMs: deps.config.aiModel.timeoutMs,
  provider: "ollama",
});
```

The `token` field is typed as `string | null` and used only as a Bearer token.

---

## 3. Whether the application can currently authenticate against the endpoint

**No — the application cannot currently authenticate against the endpoint.**

The endpoint requires HTTP Basic Authentication. The application sends a Bearer token (or nothing). An unauthenticated or Bearer-authenticated request to the Nginx-protected Ollama endpoint will be rejected with **HTTP 401**, because Nginx will not find valid Basic Auth credentials in the `Authorization` header.

The existing `AI_TOKEN` secret (if it contains a token string) cannot be used as a Basic Auth password, because:
- It is not paired with a username in the application.
- The Nginx `auth_basic_user_file` expects `username:password_hash`, and Basic Auth requires both a username and password sent as `Authorization: Basic base64(username:password)`.
- The application sends `Authorization: Bearer <token>`, which Nginx's `auth_basic` module does not understand.

**This is a protocol mismatch, not a missing secret value.** Even if `AI_TOKEN` is set to the correct password, the application would still send it as a Bearer token, which Nginx would reject.

---

## 4. The precise incompatibility causing HTTP 401

The HTTP 401 response is caused by this exact mismatch:

| Layer | What it expects | What Medveris sends |
|-------|----------------|---------------------|
| Nginx (`auth_basic`) | `Authorization: Basic <base64(username:password)>` | — |
| Medveris (`createLiveOllamaClient`) | — | `Authorization: Bearer <AI_TOKEN>` (or nothing) |

The Nginx `auth_basic` module only recognizes the `Basic` scheme. It does not process Bearer tokens. When Medveris sends `Authorization: Bearer ...` (or sends no Authorization header at all), Nginx rejects the request with HTTP 401 because no valid Basic Auth credentials are present.

**Root cause:** `apps/api/src/integrations/ollama.ts:createLiveOllamaClient` constructs only a Bearer Authorization header from `settings.token`. There is no code path for constructing a Basic Auth header from a username and password.

---

## 5. The smallest code/configuration change needed to support existing Basic Auth

### What needs to change

The application's Ollama client must be able to construct an HTTP Basic Authentication header when the endpoint requires it, instead of (or in addition to) a Bearer token.

**Smallest compatible change:** Extend the live Ollama client configuration to accept an optional `basicAuth` credential pair (username + password), and construct the `Authorization` header as `Basic base64(username:password)` when present, while keeping the existing Bearer path for providers that use it.

Concretely, this means:

1. **Add new configuration fields** to `AiConfig` (or a parallel structure) for `ollamaUsername` and `ollamaPassword` (or a single `basicAuth` object), read from new environment variables such as `OLLAMA_USERNAME` and `OLLAMA_PASSWORD`.

2. **Update `createLiveOllamaClient`** to accept these credentials and, when provided, send `Authorization: Basic ...` instead of (or in preference to) `Authorization: Bearer ...`.

3. **Keep the existing `AI_TOKEN` Bearer path** for any provider that still uses Bearer authentication, to avoid breaking other integrations. The Basic Auth path is specific to this Ollama endpoint.

4. **Update the production gate** (`scripts/production-gate.mjs` and `tests/unit/production-gate.test.ts`) to require the new secrets when `FEATURE_AI=true` and the endpoint is the Basic-Auth-protected Ollama host, and to reject credential embedding in `AI_BASE_URL` (already done).

5. **Update the integration registry** (`apps/api/src/integrations/registry.ts`, `aiConfigProblems`) to require the new credentials for the live Ollama path when appropriate.

6. **Do not change `AI_BASE_URL`** — continue using `https://ollama.medveris.online`.

7. **Do not change the model** — continue using `llama3.2:latest` (or the configured `AI_MODEL`).

### What does NOT need to change

- The Nginx configuration on the VPS. It is correct and must be preserved.
- The `auth_basic_user_file` or its permissions.
- The Ollama Docker container, private listener, or network.
- The endpoint hostname or TLS configuration.
- The model provider (still Ollama / llama3.2:latest).
- The sandbox path (local OLLAMA_URL) — that is separate and unchanged.
- The `AI_MODE` / `AI_MODE` environment separation logic.
- The `FEATURE_AI=false` production safety state — that stays until approved.

---

## 6. The required staging and production secret names

### Current state

Both staging and production already have these AI-related secrets defined:

| Secret | Staging | Production |
|--------|---------|------------|
| `AI_BASE_URL` | `secret_text` | `var` in `wrangler.jsonc` (`"https://ollama.medveris.online"`) |
| `AI_MODE` | `secret_text` | — |
| `AI_MODEL` | `secret_text` | — |
| `AI_TOKEN` | `secret_text` | `secret` in `secrets.required` |

Note: `AI_BASE_URL`, `AI_MODE`, and `AI_MODEL` are listed as `secret_text` in staging but as `vars` in production `wrangler.jsonc`. In production, `AI_BASE_URL` is a plaintext var (the URL only, no credentials — this is correct and passes the gate's "no credentials in URL" check).

### Proposed migration (not yet implemented — requires approval)

To support HTTP Basic Auth, introduce two new secrets:

| Secret | Purpose | Staging | Production |
|--------|---------|---------|------------|
| `OLLAMA_USERNAME` | Nginx Basic Auth username | `secret_text` | `secret` in `secrets.required` |
| `OLLAMA_PASSWORD` | Nginx Basic Auth password | `secret_text` | `secret` in `secrets.required` |

These would be read by `aiConfig` (or a new helper) and passed to the Ollama client, which would construct the Basic Auth header.

**The existing `AI_TOKEN` secret would remain** for any Bearer-token providers. For this specific Ollama endpoint, the Basic Auth credentials would be used instead.

**The application would determine which auth scheme to use based on configuration**: if `OLLAMA_USERNAME`/`OLLAMA_PASSWORD` are set for the live Ollama path, use Basic Auth; otherwise fall back to the existing Bearer behavior with `AI_TOKEN`.

### Important constraints

- The existing password in `/etc/nginx/.htpasswd_ollama` **cannot be retrieved** through Wrangler or the application. Its value is known only on the VPS. The username is also only known from the htpasswd file content, which I did not read (and will not).
- I cannot set, reset, or reveal these credentials. I can only propose the secret names and the code changes to use them.
- Staging and production must have **separate** values for these secrets. They must not share the same username/password unnecessarily (though in practice the same Nginx htpasswd file may be used for both environments if they share the same Ollama instance — that is a VPS-level decision, not an application change).

---

## 7. Tests that can be performed without exposing credentials

### 7.1 Application authentication-header construction (unit tests)

Test that the Ollama client constructs the correct `Authorization` header for each auth mode:

- **Basic Auth path:** When `ollamaUsername`/`ollamaPassword` (or equivalent) are provided, the client sends `Authorization: Basic <base64(username:password)>`.
- **Bearer path:** When only `AI_TOKEN` is provided (and no Basic Auth credentials), the client sends `Authorization: Bearer <AI_TOKEN>`.
- **No auth path:** When neither is provided (sandbox/local), no `Authorization` header is sent.
- **Header precedence:** If both Basic Auth credentials and `AI_TOKEN` are configured, the Basic Auth header is used for the Ollama endpoint (or the behavior is made explicit and tested).

These tests can use fake/mocked credentials (e.g., `username = "test-user"`, `password = "test-password"`) and assert on the header construction without exposing real credentials. The base64-encoded value can be checked in the test without printing real secrets.

### 7.2 Basic Auth compatibility with the existing Nginx authentication mechanism

This requires a live authenticated request. It can be tested safely by:

- Using the actual `OLLAMA_USERNAME` and `OLLAMA_PASSWORD` (once set as secrets) in a staging deployment.
- Making a single authenticated request to `https://ollama.medveris.online/api/version` (a read-only, lightweight endpoint) from the staging Worker or from a verification script.
- Asserting that the response is HTTP 200 with a valid Ollama version JSON, not HTTP 401.

This test must **not** print or log the credentials. It can assert only on the response status and the presence of a version string.

### 7.3 Correct endpoint and model selection

- Assert that the live Ollama client targets `https://ollama.medveris.online` (from `AI_BASE_URL`).
- Assert that it uses the configured model (`AI_MODEL`, defaulting to `llama3.2` / `llama3.2:latest`).
- Assert that the request is sent to `/api/chat` with the correct JSON body format.

These are unit tests with mocked fetch, no live credentials needed.

### 7.4 Staging configuration validation

- Load the staging configuration and assert that `AI_BASE_URL` is `https://ollama.medveris.online`.
- Assert that the new `OLLAMA_USERNAME`/`OLLAMA_PASSWORD` secrets are required in staging when `FEATURE_AI=true`.
- Assert that the integration registry reports the AI integration as misconfigured or unverified when the Basic Auth credentials are missing.
- Assert that the production gate (`scripts/production-gate.mjs`) requires the new secrets when `FEATURE_AI=true`.

### 7.5 Production configuration validation

- Assert that production `wrangler.jsonc` requires `OLLAMA_USERNAME` and `OLLAMA_PASSWORD` in `secrets.required` when `FEATURE_AI=true`.
- Assert that `AI_BASE_URL` remains `https://ollama.medveris.online` and contains no embedded credentials.
- Assert that `FEATURE_AI=false` in production (current state) and that the gate enforces this until approved.
- Assert that production terminology remains `local-reference`.

### 7.6 AI request and response handling

- Mock a successful Ollama `/api/chat` response and assert the application maps it correctly to the `AiRunResult` shape (text, usage tokens).
- Mock an HTTP 401 response and assert the application raises an `OllamaError` or retryable error with the correct status.
- Mock an HTTP 403, 429, 5xx, timeout, and connection-refused response and assert correct error handling.
- Assert that the application does not log or expose the Authorization header or credentials in error messages.

### 7.7 Error handling for HTTP 401, 403, 429, 5xx, timeouts, and unavailable providers

- Unit tests with mocked fetch responses for each error case.
- Assert the error type, retryability, and that no credential data leaks into error messages or logs.
- The existing `OllamaError` class with `retryable = true` is used; verify that 401/403 are handled appropriately (likely not retryable in the same way, or retried only after credential rotation — this is a design decision to confirm).

### 7.8 Streaming behavior (if supported)

- The current `createLiveOllamaClient` uses `stream: false`. If streaming is to be supported, test that the streaming path also includes the correct Basic Auth header.
- Verify that the streaming response is handled correctly end-to-end with mocked fetch.

### 7.9 Background AI job lifecycle

- Test that `aiJobRuntime` in `apps/api/src/worker.ts` uses the same auth configuration as the request-path client.
- Test that the jobs runner (`apps/jobs/src/ai.ts`) correctly handles the authenticated client, including retry behavior, dead-lettering, and status updates.
- Test that the job records the correct `provider` (`ollama`) and `source` (`live:ollama`) when using the live Basic Auth path.

### 7.10 Verification run (AI conformance)

- The existing `runAiVerification` in `apps/api/src/integrations/ai-verification.ts` calls `createLiveOllamaClient` and runs `/api/version`, `/api/tags`, and model-inventory checks.
- With Basic Auth credentials configured, this verification run would be the mechanism that proves authenticated connectivity.
- Test that the verification run succeeds (with mocked authenticated fetch) and records a passing verification in `integration_verifications`.
- Test that the verification run fails with HTTP 401 when credentials are missing or wrong, and that the failure is recorded correctly.

---

## 8. Any missing information that requires my intervention

### 8.1 The Basic Auth username

I did not read the contents of `/etc/nginx/.htpasswd_ollama`. The file exists (45 bytes, `root:www-data`, `640`), but its content — and therefore the username — was not disclosed.

**Required from you:** The Nginx Basic Auth username that corresponds to the existing htpasswd file. This is needed to configure `OLLAMA_USERNAME`.

### 8.2 The Basic Auth password

The password hash is in `/etc/nginx/.htpasswd_ollama`. I cannot retrieve or reverse it. The plaintext password is known only on the VPS.

**Required from you:** The plaintext password (or confirmation that it can be used as the `OLLAMA_PASSWORD` secret value). If the password is not available, a new htpasswd entry would need to be created on the VPS and the new credentials supplied — but that would change the existing authentication setup, which the instructions say to avoid unless necessary.

### 8.3 Whether `AI_TOKEN` currently holds a value

I cannot read Cloudflare secret values. The staging and production environments both have `AI_TOKEN` defined as a secret, but I do not know its value.

**Required from you:** If `AI_TOKEN` is intended to be repurposed as the Basic Auth password, that must be explicitly confirmed. Otherwise, treat `AI_TOKEN` as a Bearer token for other purposes and introduce separate `OLLAMA_USERNAME`/`OLLAMA_PASSWORD` secrets. The instructions say not to repurpose an existing token as a Basic Auth password without evidence that it is intended for that purpose.

### 8.4 The Ollama model name in the server inventory

The application is configured to use `llama3.2:latest` (from `AI_MODEL` / `ollamaConfig` default), but I have not verified that this exact model name is present in the Ollama server's `/api/tags` inventory. The Nginx proxy passes requests to `127.0.0.1:11434`, and the Ollama process is running, but the model inventory has not been inspected.

**Required from you (or verifiable after authentication works):** Confirm that `llama3.2:latest` (or the configured `AI_MODEL`) is present in the Ollama model inventory. If it is not, the model name in the application configuration must match what the server reports.

### 8.5 Staging vs production Ollama endpoint

The instructions say both environments must use the same Basic Auth mechanism. It is not yet confirmed whether staging and production share the same Ollama instance (same Nginx htpasswd file) or have separate instances.

**Required from you:** Confirm whether staging and production use the same Ollama endpoint (`https://ollama.medveris.online`) and the same htpasswd credentials, or whether staging has a separate endpoint/credentials. The current wrangler config sets `AI_BASE_URL` to `https://ollama.medveris.online` in production; staging has it as a secret_text but the value is not visible to me.

### 8.6 Current Cloudflare secret values for `AI_BASE_URL`, `AI_MODE`, `AI_MODEL` in staging

These are listed as `secret_text` in staging but I cannot read their values. I know:
- Production `AI_BASE_URL` is `https://ollama.medveris.online` (from `wrangler.jsonc` var).
- Production `AI_MODEL` is not set as a var in `wrangler.jsonc` (only `AI_BASE_URL` is set; `AI_MODEL` is not in the production vars list). This may be a gap — the production gate requires a non-empty `AI_MODEL` when `FEATURE_AI=true`.

**Required from you:** Confirm the staging values of `AI_BASE_URL`, `AI_MODE`, and `AI_MODEL`, and whether production `AI_MODEL` is set as a secret.

---

## 9. File-by-file implementation proposal

### Summary of changes

These are proposed changes only. None are implemented yet. All changes preserve existing behavior for the sandbox path and for any Bearer-token providers. The Basic Auth path is additive.

### 9.1 `apps/api/src/config.ts`

**Add:** New configuration fields for Ollama Basic Auth credentials.

- Extend `AiConfig` (or create a parallel `OllamaBasicAuth` config) to include optional `username` and `password` fields.
- Add an `aiOllamaBasicAuth` (or similar) function that reads `OLLAMA_USERNAME` and `OLLAMA_PASSWORD` from the environment, with the same secrecy constraints as `AI_TOKEN` (i.e., must be a Worker secret, not a plaintext var).
- The existing `aiConfig` function (reading `AI_BASE_URL` and `AI_TOKEN`) remains unchanged.

**Proposed new interface:**

```typescript
export interface AiConfig {
  baseUrl: string | null;
  token: string | null;
  /** HTTP Basic Auth credentials for the live Ollama endpoint, when it uses auth_basic. */
  ollamaBasicAuth: { username: string | null; password: string | null };
}
```

**Proposed new env reader:**

```typescript
function ollamaBasicAuthConfig(env: EnvLike): { username: string | null; password: string | null } {
  const username = (env.OLLAMA_USERNAME ?? "").trim() || null;
  const password = (env.OLLAMA_PASSWORD ?? "").trim() || null;
  return { username, password };
}
```

**Production gate impact:** The production gate must require `OLLAMA_USERNAME` and `OLLAMA_PASSWORD` as secrets when `FEATURE_AI=true` and the endpoint is the Basic-Auth-protected Ollama host. If the endpoint is a Bearer-token provider, the gate still requires `AI_TOKEN`. The gate may need to distinguish between the two auth schemes based on configuration or endpoint identity.

### 9.2 `apps/api/src/integrations/ollama.ts`

**Add:** Basic Auth header construction in `createLiveOllamaClient`.

- Extend the `settings` parameter to accept `basicAuth: { username: string | null; password: string | null }` (or reuse the new `AiConfig.ollamaBasicAuth` fields).
- When `basicAuth.username` and `basicAuth.password` are both non-null, construct the `Authorization` header as:

  ```typescript
  const basicAuth = Buffer.from(`${basicAuth.username}:${basicAuth.password}`).toString("base64");
  authorization: `Basic ${basicAuth}`
  ```

  Or, using the Web Crypto API (since this runs in a Cloudflare Worker, not Node):

  ```typescript
  const basicAuth = btoa(`${basicAuth.username}:${basicAuth.password}`);
  authorization: `Basic ${basicAuth}`
  ```

- The existing Bearer path (`authorization: \`Bearer ${settings.token}\``) remains for providers that use it. If both Basic Auth credentials and a Bearer token are configured, choose one explicitly (recommend: Basic Auth takes precedence for the Ollama endpoint, with the behavior documented and tested).

**Apply to both call sites:**

1. `apps/api/src/lib/ai.ts` — `aiDependencies()` function, live Ollama path.
2. `apps/api/src/worker.ts` — `aiJobRuntime()` function, live Ollama path.
3. `apps/api/src/integrations/ollama.ts` — `loadAiStatus()` function.
4. `apps/api/src/integrations/ai-verification.ts` — `loadAiStatus()` and `runAiVerification()` functions.

**Do NOT change:**

- `createOllamaClient` (sandbox path) — unchanged, no auth header.
- `apps/jobs/src/ai.ts` — `aiRuntimeFromEnv()` (local dev sandbox) — unchanged.

### 9.3 `apps/api/src/lib/ai.ts`

**Update:** Pass the new Basic Auth credentials to `createLiveOllamaClient`.

```typescript
const client = createLiveOllamaClient({
  baseUrl: deps.config.ai.baseUrl,
  token: deps.config.ai.token,
  basicAuth: deps.config.ai.ollamaBasicAuth,
  model: deps.config.aiModel.model,
  timeoutMs: deps.config.aiModel.timeoutMs,
  provider: "ollama",
});
```

### 9.4 `apps/api/src/worker.ts`

**Update:** Pass the new Basic Auth credentials to `createLiveOllamaClient` in `aiJobRuntime()`.

```typescript
const client = createLiveOllamaClient({
  baseUrl: config.ai.baseUrl,
  token: config.ai.token,
  basicAuth: config.ai.ollamaBasicAuth,
  model: config.aiModel.model,
  timeoutMs: config.aiModel.timeoutMs,
  provider: "ollama",
});
```

### 9.5 `apps/api/src/integrations/registry.ts`

**Update:** `aiConfigProblems()` to require the Basic Auth credentials for the live Ollama path.

- When `config.features.ai` is true and `config.modes.ai` is not sandbox and `config.ai.baseUrl` is set:
  - If the endpoint is the Basic-Auth-protected Ollama host (e.g., `ollama.medveris.online`), require `OLLAMA_USERNAME` and `OLLAMA_PASSWORD` (or `config.ai.ollamaBasicAuth.username`/`password` to be non-null).
  - If the endpoint uses Bearer auth, require `AI_TOKEN` as before.
  - The problem messages should clearly distinguish the two auth schemes.

**Proposed wording:**

```
"OLLAMA_USERNAME is not set for the live Ollama provider (HTTP Basic Auth)"
"OLLAMA_PASSWORD is not set for the live Ollama provider (HTTP Basic Auth)"
```

### 9.6 `apps/api/src/integrations/ai-verification.ts`

**Update:** `runAiVerification()` to use the Basic Auth credentials when constructing the client.

- The verification run is the proof that authenticated connectivity works. With Basic Auth configured, the verification run would call `/api/version` and `/api/tags` with the Basic Auth header and prove that the endpoint responds.
- No other changes needed to the verification logic — it already uses `createLiveOllamaClient` and checks version, model inventory, and requested-model-presence.

### 9.7 `apps/api/src/routes/admin.ts`

**Inspect:** The AI verification endpoint (line ~438 references `AI_BASE_URL`). Verify that the admin verification route also uses the updated client configuration. If it constructs its own `createLiveOllamaClient` call, update it to pass the Basic Auth credentials.

### 9.8 `scripts/production-gate.mjs`

**Update:** `requiredProductionSecrets()` and `checkProductionConfig()` to require `OLLAMA_USERNAME` and `OLLAMA_PASSWORD` when `FEATURE_AI=true` and the endpoint requires Basic Auth.

- Add `OLLAMA_USERNAME` and `OLLAMA_PASSWORD` to the set of required secrets for the AI integration when the endpoint is the Basic-Auth Ollama host.
- Keep the existing `AI_TOKEN` requirement for Bearer-token providers.
- Add a check that `OLLAMA_USERNAME` and `OLLAMA_PASSWORD` are declared in `secrets.required` when the live Ollama path is configured for Basic Auth.
- The check that `AI_BASE_URL` must not embed credentials is already present and correct — keep it.

### 9.9 `tests/unit/production-gate.test.ts`

**Update:** Add test cases for the new Basic Auth secrets.

- Case: `FEATURE_AI=true` with `AI_BASE_URL=https://ollama.medveris.online` requires `OLLAMA_USERNAME` and `OLLAMA_PASSWORD` secrets to be declared.
- Case: `FEATURE_AI=true` with a Bearer-token provider endpoint requires `AI_TOKEN` (existing behavior preserved).
- Case: `OLLAMA_USERNAME` and `OLLAMA_PASSWORD` are not allowed as plaintext vars (they look like secrets and must be in `secrets.required`).
- Preserve all existing test cases.

### 9.10 `tests/unit/ai-status.test.ts`

**Update:** Add test cases for the Basic Auth configuration.

- Test that `aiConfigProblems` reports missing `OLLAMA_USERNAME`/`OLLAMA_PASSWORD` when the live Ollama path is configured for Basic Auth.
- Test that the integration status reports misconfigured when Basic Auth credentials are missing.
- Test that the configuration is complete when both `AI_BASE_URL` and the Basic Auth credentials are set.
- Preserve all existing test cases (which use `AI_TOKEN` for the Bearer path).

### 9.11 New or updated unit tests for header construction

**Add:** A new test file or extend `apps/api/src/integrations/ollama.ts` tests to verify:

- Basic Auth header construction: given username `u` and password `p`, the client sends `Authorization: Basic <btoa("u:p")>`.
- Bearer header construction: given token `t`, the client sends `Authorization: Bearer t`.
- No auth header when neither is configured.
- Header precedence when both are configured (behavior to be defined).
- The header is not logged or exposed in error messages.

These tests use fake credentials and mock fetch — no real credentials are exposed.

### 9.12 Wrangler configuration (`wrangler.jsonc`)

**Update (requires approval before implementation):**

- Add `OLLAMA_USERNAME` and `OLLAMA_PASSWORD` to `env.production.secrets.required`.
- Add `OLLAMA_USERNAME` and `OLLAMA_PASSWORD` as `secret_text` in `env.staging.secrets`.
- Do NOT add them as plaintext vars (they are secrets).
- The existing `AI_BASE_URL` var in production remains unchanged (it is the URL, not credentials).
- The existing `AI_TOKEN` secret remains (for Bearer providers).

### 9.13 Cloudflare secrets (staging and production)

**Set (requires your approval and action):**

- `wrangler secret put OLLAMA_USERNAME --env staging`
- `wrangler secret put OLLAMA_PASSWORD --env staging`
- `wrangler secret put OLLAMA_USERNAME --env production`
- `wrangler secret put OLLAMA_PASSWORD --env production`

The values are the Nginx Basic Auth username and password. I cannot set these — you must provide them.

---

## 10. Any VPS changes that would genuinely be necessary, if any

### None, if the existing htpasswd file and credentials are used.

If the existing `/etc/nginx/.htpasswd_ollama` file and its current username/password are used as the `OLLAMA_USERNAME`/`OLLAMA_PASSWORD` secrets, **no VPS changes are needed**. The Nginx configuration is already correct and must be preserved.

### Only if credentials need to be created or changed

If the existing password is not available (e.g., it was lost and cannot be recovered from the htpasswd file), then a new htpasswd entry would need to be created on the VPS:

```bash
# Example only — do not run without approval
sudo htpasswd -c /etc/nginx/.htpasswd_ollama <new_username>
```

This would change the existing authentication setup by replacing the password file contents. The instructions say to avoid changing the existing Basic Auth file unless necessary. If the existing credentials are available, use them.

### File ownership and permissions

The existing file permissions (`640`, `root:www-data`) are correct and must be preserved. No change to them is needed.

### Nginx reload

If the htpasswd file is changed (only if necessary), Nginx must be reloaded:

```bash
sudo nginx -t && sudo nginx -s reload
```

This is only needed if the password file changes. If the existing credentials are used as-is, no reload is needed.

### Ollama container / process

No changes to the Ollama container, private listener, or process are needed. The Ollama server itself does not handle authentication — Nginx does. The Ollama process at `127.0.0.1:11434` receives proxied requests from Nginx after Nginx has validated the Basic Auth credentials.

---

## Summary of verified facts vs assumptions vs recommendations

### Verified facts

1. The Nginx virtual host at `/etc/nginx/sites-enabled/ollama.medveris.online` uses `auth_basic "Ollama restricted"` with `auth_basic_user_file /etc/nginx/.htpasswd_ollama`.
2. The htpasswd file exists at `/etc/nginx/.htpasswd_ollama`, owned by `root:www-data`, permissions `640`, 45 bytes.
3. The Nginx config proxies to `http://127.0.0.1:11434` (the Ollama private listener).
4. The Ollama process (`/bin/ollama serve`) is running on the VPS.
5. TLS is configured with Let's Encrypt certificates managed by Certbot.
6. The Medveris application's live Ollama client (`createLiveOllamaClient`) sends `Authorization: Bearer <AI_TOKEN>` when `AI_TOKEN` is set, and sends no Authorization header otherwise.
7. The application does not construct an `Authorization: Basic` header from a username and password.
8. Production `wrangler.jsonc` sets `AI_BASE_URL = "https://ollama.medveris.online"` and lists `AI_TOKEN` in `secrets.required`.
9. Staging has `AI_BASE_URL`, `AI_MODE`, `AI_MODEL`, and `AI_TOKEN` as `secret_text`.
10. The production gate requires `AI_TOKEN` when `FEATURE_AI=true` and rejects credential embedding in `AI_BASE_URL`.
11. `FEATURE_AI=false` in production, and production terminology is `local-reference`.
12. The unit tests for AI status and production gate pass with the current configuration.

### Assumptions

1. The Nginx Basic Auth username is the first field in the htpasswd file's single entry. I did not read the file, so I do not know the username.
2. The Nginx Basic Auth password is the second field (the hash) in the htpasswd file. I did not read the file, so I do not know the password or its plaintext value.
3. The existing `AI_TOKEN` secret is a Bearer token, not intended for use as a Basic Auth password. This is assumed based on the naming and the application's Bearer-only usage. If it is intended for Basic Auth, that must be confirmed.
4. Staging and production use the same Ollama endpoint (`https://ollama.medveris.online`) and the same Nginx htpasswd credentials. This is assumed based on the production `AI_BASE_URL` value; staging's value is not visible to me.
5. `llama3.2:latest` is present in the Ollama server's model inventory. This has not been verified.

### Recommendations

1. **Do not change the Nginx configuration or the htpasswd file.** The existing Basic Auth setup is correct and must be preserved.
2. **Introduce `OLLAMA_USERNAME` and `OLLAMA_PASSWORD` as Cloudflare secrets** (staging and production), separate from `AI_TOKEN`. Use the existing htpasswd credentials as the values.
3. **Extend the Ollama client to support Basic Auth** as an alternative to Bearer auth, keeping the existing Bearer path for other providers.
4. **Update the production gate and tests** to require the new secrets and to test the Basic Auth path.
5. **Verify authenticated connectivity in staging** before considering production activation. Use `runAiVerification` or a direct `/api/version` call with the Basic Auth credentials.
6. **Keep `FEATURE_AI=false` in production** until staging verification succeeds and explicit approval is given.
7. **Do not repurpose `AI_TOKEN` as a Basic Auth password** unless it is explicitly confirmed that the token is intended for that purpose.
8. **Do not activate production AI** until a real authenticated inference succeeds in staging.

---

**End of report.**

*This report is based on inspection of the Medveris application code, the wrangler configuration, the production gate script and tests, the Cloudflare secret listings, and a live SSH inspection of the VPS Nginx configuration. It does not modify any files, set any credentials, change Nginx, or deploy anything. Implementation requires your explicit approval.*
