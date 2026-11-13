# Phase 12 — Role-aware AI assistant (2026-11-13)

Program label: *role-aware, mobile-first AI chat for patients and providers*.
This document is the design record required by the "# ROLE — senior product designer" brief pasted by the
product owner on 2026-11-13, plus the implementation record for what was actually shipped in this slice.

Scope guard: this is a **new phase**. Everything pre-existing (`apps/web` conversation audit of 2026-11-09,
`AIPage` job history, `ai_jobs` pipeline) is preserved. Production `FEATURE_AI` remains `false`; the
assistant stays fail-closed until a provider is configured **and** verified.

## Understanding restated, with critical assumptions

**Understanding.** One conversational surface, two audiences with different tones, capabilities and risk
profiles. The interface is mobile-first (design at 360×800), one-handed, bottom-anchored composer, WCAG 2.2
AA, 48px touch targets, color never the sole signal, AI content always labelled, and safety outranks
delight. Both audiences share the same thread component, but the audience is resolved from the **server-side
session**, not from a client flag. Emergency signals interrupt the normal flow deterministically.

**Critical assumptions (all flagged for clinical/legal review — see Open Questions)**

1. Emergency escalation uses generic "112 or 999" copy (Uganda/East-African context). The exact national
   number(s) and wording require ministry-of-health / clinical-governance sign-off.
2. Red-flag detection is a deterministic, English-first keyword/pattern heuristic shared between client and
   server (`packages/domain/src/red-flag.ts`). It is a safety net, **not** a diagnosis. Local languages and
   dialects are uncovered; multilingual coverage is a required follow-up.
3. No patient record context is injected into the model. Patient mode answers general health questions;
   provider mode gives decision support without the chart. Chart-grounded answering is a separate, governed
   slice (consent + audit + retrieval scoping) and is **not implemented** here.
4. Voice-to-text (Web Speech API) and photo attach are designed but **not built** in this slice. The
   composer stays text-first by design; nothing pretends to capture voice or images.
5. Offline is honest: messages typed offline are marked failed, stay on the device, and are retried
   manually. There is no silent background queue that lies about delivery.
6. The crisis reply and card treat **all** red flags uniformly (112/999 + nearest facility + crisis-line
   wording). Self-harm-specific referral routing needs a clinician-approved protocol and crisis-line
   partnership before production exposure.
7. AI provider: Ollama (self-hosted), sandbox in dev/test; live path requires a verified provider
   (Basic-Auth supported by the codebase since 2026-11). `FEATURE_AI=false` in production — nothing here
   makes production AI live.
8. Patient mode does not require MFA (portal session); provider mode requires an active facility context and
   an **MFA-verified session** (same as other staff AI surfaces) plus a clinical role.
9. Audit is metadata-only: `ai.chat.turn` rows carry `mode`, `redFlag`, `redFlagCategory`, `messageCount` —
   **never message content**, never identifiers beyond the actor.
10. Governance: patient-facing use in production requires DPIA/clinical-governance sign-off (as with Phase
    11 surfaces). This phase must not be promoted to production patient-facing use without it.

## 1. UX strategy — goals, flows, risks per role

### Patient mode (audience badge "Patient")

| Goals | Key flows | Top risks & mitigations |
|---|---|---|
| Understand symptoms/results in plain language; know when to escalate; book/manage care; feel heard | "I feel unwell" → one clarifying question at a time → general guidance + reminder to see a clinician; escalation is always one tap | Unsafe self-diagnosis → never diagnoses; always "not medical advice"; red flags pre-empt the model with a fixed crisis card |
| | "I have a question about my medicine" → general information; refuses medication changes; directs to clinician/pharmacy | Over-trust of AI output → bubble-level "AI assistant" label, disclaimers in footer + bubble, sources never fabricated |
| | "I need to talk to a human" → escalation copy (call facility/nearest services; 112/999 for emergencies) | Missed emergency → deterministic red-flag gate, works offline, pre-empts inference |
| | Understand results → plain-language explanation of what a result type means; never interprets the patient's actual values without chart grounding (not built) | Privacy leakage → no PHI in prompts sent without explicit future consent slice; audit metadata-only |

### Provider mode (audience badge "Provider")

| Goals | Key flows | Top risks & mitigations |
|---|---|---|
| Fast decision support; draft-quality artifacts; confidence before acting; audit trail | "What are red flags for chest pain?" → concise answer + "confirm in record" footer | Unsafe autonomy → explicit "I assist, you decide" framing; clinician owns every decision |
| | "Summarize this patient before my visit" → **not available** (no chart grounding); assistant says so rather than inventing a summary | Fabricated context → never injects record data it does not have; refuses invented citations |
| | "Draft a referral note" → structured draft the provider reviews and pastes into the note composer | Over-reliance → verify-in-record disclaimers; AI never writes to the chart autonomously |

### Shared

| Goals | Key flows | Top risks & mitigations |
|---|---|---|
| Safety, privacy, auditability, accessibility | Any red flag → emergency card interrupts thread (112/999 call actions); offline path shows the same card; audit `ai.chat.turn` with `redFlag:true` | Prompt injection via user text → model treats messages as data; server never executes instructions from messages; deterministic safety gate is independent of model output |
| | Dual-role users switch audience with an explicit, re-confirmed switcher | Audience confusion → mode derived server-side from session; client cannot request a mode it is not entitled to |
| | WCAG 2.2 AA; 48px targets; RTL-ready logical properties; dynamic type | Exclusion → 16px inputs, fluid type, semantic roles, screen-reader labels on every status |

## 2. Role-permission matrix

| # | Capability | Patient | Provider (clinical) | Dual-role | Staff (non-clinical) | Notes |
|---|---|---|---|---|---|---|
| 1 | Open the assistant | ✅ `/portal/assistant` | ✅ `/ai/chat` | ✅ both + switcher | ❌ (route 403/deny) | server derives + enforces mode |
| 2 | Patient plain-language Q&A | ✅ | ✅ (patient mode) | ✅ patient mode | ❌ | never chart-grounded |
| 3 | Provider decision support | ❌ | ✅ clinical roles only | ✅ with re-confirmation | ❌ | nurse, midwife, clinician, specialist_clinician, pharmacist |
| 4 | MFA required | portal session | ✅ (requireStaff) | provider mode ✅ | — | patient mode: no MFA |
| 5 | Quick replies | ✅ patient chips | ✅ provider chips | per active mode | — | |
| 6 | Red-flag crisis card | ✅ always | ✅ always | ✅ always | — | deterministic; pre-empts model |
| 7 | Emergency call actions | ✅ tel:112/999 | ✅ tel:112/999 | ✅ | — | |
| 8 | Chart injection into prompt | ❌ (not built) | ❌ (not built) | ❌ | ❌ | future governed slice |
| 9 | AI writes back to chart | ❌ never | ❌ never (paste into composer) | ❌ | — | AI never decides |
| 10 | Audit visibility | subject of rows | subject/actor of rows | per session | — | metadata-only |
| 11 | "Talk to a human" handoff | escalation copy → call facility | "confirm in record" → existing worklist/note composer | both | — | patient→clinician thread needs backend (not built) |
| 12 | Session expiry handling | 401 → re-login | 401 → re-login | both | — | |
| 13 | Offline behavior | failed + manual retry | same | same | — | nothing pretends to send |

Provider routes are gated by `ProtectedRoute roles={["nurse","midwife","clinician","specialist_clinician","pharmacist"]}`
(web) and server-side mode derivation + `requireStaff` + role check (API). Patient route gated by
`ProtectedRoute patient`. The audience switcher is client-side convenience; the server always re-derives.

## 3. Information architecture & key flows

```
/portal/assistant  (patient nav "Intelligence → AI assistant", mobile "more", patientOnly)
  └─ AIChatPage (mode = patient)  ── Greeting (patient tone) → chips → free text → POST /api/v1/ai/chat
/ai/chat           (staff nav "Intelligence → AI assistant", mobile "knowledge")
  └─ AIChatPage (mode = provider) ── Greeting (provider tone) → chips → POST /api/v1/ai/chat
```

**Patient triage flow**
```
open /portal/assistant → greeting ("Hello. I can help with general health questions…")
  → chip "I feel unwell" → assistant asks ONE clarifying question (fever? since when? worst symptom?)
  → user: "chest pain and pressure" → red-flag gate matches chest_pain
  → SERVER returns fixed crisis reply (never model); CLIENT renders EmergencyCard:
       "This could be an emergency" + [Call 112] [Call 999] + do-not-wait copy
  → audit ai.chat.turn{mode:patient, redFlag:true, redFlagCategory:chest_pain}
  → user may keep typing after the card (thread is not locked)
```

**Provider review flow**
```
open /ai/chat (MFA-verified clinical role) → greeting ("Clinical decision support…")
  → free text "What are red flags for chest pain?"
  → concise list + "Confirm against the record…" footer → audit ai.chat.turn{mode:provider}
```

**Emergency escalation (both modes)**: any message matching `red-flag.ts` categories
(chest_pain, stroke, severe_bleeding, breathing, anaphylaxis, severe_allergic_reaction, self_harm,
loss_of_consciousness) → fixed crisis reply + emergency card; model never called; works offline.

**Clinician handoff (patient)**: chip "I need to talk to a human" → not a model question; the assistant
replies with human-escalation copy (call your facility, nearest facility, 112/999, portal care team).
A first-class patient→clinician message queue is a required follow-up (not built; see Open Questions).

**Clinician handoff (provider)**: "Confirm in the patient record" — output is advisory text the provider
incorporates into existing flows (worklist, notes composer). No autonomous chart writes.

Wireframes (360×800)

```
PATIENT                              PROVIDER
┌───────────────────────────────┐    ┌───────────────────────────────┐
│ Medveris Intelligence  [Patient]   │ Medveris Intelligence  [Provider]
│ ⚠ Not medical advice — talk to  │  │ Decision support — you decide.  │
│   a clinician                    │  │ Verify in the record.           │
├───────────────────────────────┤    ├───────────────────────────────┤
│  AI assistant                   │  │  AI assistant                   │
│  ─ You: I feel unwell           │  │  ─ You: red flags chest pain?   │
│  ─ AI assistant: Fever since…?  │  │  ─ AI assistant: chest pain + … │
│                                 │  │     confirm in record.          │
│  [ chips: I feel unwell | … ]   │  │  [ chips: Summarize | Draft ]   │
├───────────────────────────────┤    ├───────────────────────────────┤
│ ┌───────────────────────┐ [→] │  │ ┌───────────────────────┐ [→] │
│ │ Ask a health question… │      │  │ │ Ask for decision sup…  │      │
└───────────────────────────────┘    └───────────────────────────────┘
  (bottom-anchored composer,           (identical mechanics; provider
   48px input, one-tap send)            tone, chips, footer)
```

Emergency card (both modes, replaces the bubble row):

```
┌───────────────────────────────┐
│ This could be an emergency     │   role="alert", --mv-danger border
│ chest pain … call now.         │   [ Call 112 ]  [ Call 999 ]
│ Do not wait for a reply.       │
└───────────────────────────────┘
```

## 4. Screens & states

| Screen/state | Component | Status in this slice |
|---|---|---|
| Assistant thread | `ConversationPanel` (extended) | ✅ built & verified |
| Role badge (Patient/Provider) | `.mv-conversation__audience--{patient,provider}` | ✅ |
| Quick-reply chips | `.mv-conversation__chip` (scrollable, 40px, disabled while busy) | ✅ |
| Emergency card | `.mv-emergency-card` (role=alert, tel links, do-not-wait) | ✅ |
| Failed message + Retry | `.mv-conversation__status--failed` + `Retry` button | ✅ |
| Offline banner / honest queue | `Notice` + failed status; manual Retry | ✅ (no auto-send) |
| Empty/loading/error provider states | `EmptyState` / `LoadingState` / `ErrorState` | ✅ (unconfigured → honest copy) |
| Session expired | existing `api()` 401 handling → login | ✅ unchanged |
| AI uncertainty ("not sure — here's who can help") | model is instructed to state uncertainty; UI shows disclaimer | ✅ (prompt-level) |
| Symptom card (structured input) | designed; not built (needs schema + clinician review) | ⏳ open question |
| Triage result card | partially via red-flag card; formal triage scoring card not built | ⏳ |
| Medication card | not built (needs formulary grounding) | ⏳ |
| Appointment card in chat | not built (deep-link to `/portal` instead) | ⏳ |
| Voice-to-text | not built | ⏳ |
| Photo attach | not built | ⏳ |
| Real hifi mockups | implemented screens are the reference implementation (`/portal/assistant`, `/ai/chat`) | ✅ (code = hi-fi) |

## 5. Component library & tokens (`packages/ui`)

**ConversationPanel v2 additions** (all additive; existing call sites unchanged)

- `audience?: "patient" | "provider"` — header badge (`.mv-conversation__audience`), labelled `Patient` / `Provider`.
- `chips?: string[]`, `onChipSelect?: (chip: string) => void` — horizontal scroller above the composer;
  40px min-height, branded outline, disabled while busy, keyboard accessible (`role=list`).
- `kind?: "text" | "emergency"` on messages — emergency renders `.mv-emergency-card` (see tokens).
- `status` extended: `"failed"` — danger-tinted bubble + `Retry` (`onRetryMessage`) re-sends with history.
- `data-message-role` on every message row (e2e hook, accessibility).
- Assistant role label now reads **"AI assistant"** everywhere (AI-generated content always labelled).
- Multi-line model output renders with `white-space: pre-wrap`.

**Tokens** (no new color system; everything composes `--mv-*` from `packages/ui/src/styles.css`)

- Danger/crisis: `--mv-danger` (#9f1d32), `--mv-danger-soft` (#fbe7ea) — emergency card border/fill/actions.
- Brand/accent: `--mv-brand` — chips, user bubble, audience badge (patient), links.
- Surfaces: `--mv-surface`, `--mv-surface-muted`, borders `--mv-border`, text `--mv-text`, muted `--mv-text-muted`.
- Type: existing fluid scale; body 16px; headings `clamp()`. Motion respects `prefers-reduced-motion`.
- Touch: composer input 48px, send 48/44px, chips 40px, call buttons 48px, audience switch 44px.

**Emergency card (tokens + a11y):** 2px `--mv-danger` border, `--mv-danger-soft` fill, `role="alert"`,
`aria` implied by semantics, 48px `tel:112`/`tel:999` actions, focus-visible outline, never dismissible.

**Offline:** page-level `Notice tone="warning"`; message-level failed state; no spinners that lie.

## 6. Content design guidelines & microcopy

**Patient tone** — warm, plain (≈6th–8th grade), never alarming, never dismissive. One question at a time.
Always a human path. Examples:

- Greeting: "Hello. I can help with general health questions. I cannot diagnose you or change your medicine — only a clinician can. What would you like to know?"
- Red-flag dodge: "That could be serious, so I'm not the right one to ask. Please call 112 or 999 now, or go to the nearest health facility. I mean it — don't wait."
- Uncertainty: "I don't know — and I'd rather say so. A clinician at your facility can do these checks. Would you like tips on how to describe your symptoms to them?"
- Refusal (diagnosis): "I can't tell you what this is — that takes a clinician who can examine you. Here's what you can tell them…"
- Refusal (med change): "I'm not allowed to change your medicine. Please speak to your clinician or pharmacist about that dose."
- Escalation: "Please contact your facility and mention what you just told me. If it gets worse before then — 112 or 999."

**Provider tone** — concise, clinical, efficient; leads with the answer; standard terminology; states
uncertainty; ends with "confirm in the record". Examples:

- "Chest pain red flags: ECG within minutes, troponin, aortic-dissection screen if tearing pain + neuro deficit, PE protocol if pleuritic + tachycardia. Confirm against the record and facility protocol before acting."
- "Uncertain: no guideline-grade answer for this presentation. I'd escalate to a senior clinician now."
- "I can't see the patient's chart, so any summary I gave would be invented. Use the worklist and the record for the actual patient."

**Words to avoid (both modes)**: "diagnose", "prescribe", "take this now", "all clear", "you're fine",
"nothing to worry about", urgency-implying language without the emergency card.

**Status microcopy**: Sending… / Sent / Delivered / Failed to send / Retry / AI assistant / Patient /
Provider / No provider configured / You appear to be offline / Message not sent.

## 7. Open questions & assumptions needing clinical or legal review

1. Exact emergency number wording for Uganda (112/999?) and provider for crisis-line partnerships for self-harm disclosures; per-branch call routing; what happens when the caller is not the facility's patient.
2. System prompt and crisis-message review by a clinician + safeguarding lead; recurrence cadence (quarterly?).
3. DPIA/governance sign-off for patient-facing AI in production (mirrors Phase 11 gating) — required before any production promotion of `/portal/assistant`.
4. Red-flag heuristic coverage: Swahili and Luganda variants; validated against a labelled clinical corpus; sensitivity/specificity targets; false-positive budget.
5. Should self-harm disclosures page the facility/safeguarding officer or an external crisis line? (needs policy + contracts)
6. Retention of chat turns: none stored today beyond audit metadata; do we want conversation persistence with patient-consent and export/deletion rights (DPPA Art. …)? If yes, needs a `ai_chat_turns` table + consent flow — design exists, not built.
7. Provider mode: patient-context injection (chart grounding) — separate consent/retrieval/audit design; nothing in this slice implies it.
8. Whether `/ai/chat` stays behind facility-role gating (nurse/midwife/clinician/specialist/pharmacist) or extends to enrolled pharmacist counters and credit clerks; current scope is clinical-only by design.
9. Liability labelling: exact wording of the "decision support only" disclaimer approved by legal/insurers; placement (bubble, footer, both — we do both).
10. Model selection & residency: which Ollama model is approved for PHI-adjacent text; where it runs (ollama.medveris.online = VPS in Uganda); whether EU-hosted residency is required for any data class.
11. Offline UX for low-literacy users: icons-only mode, read-aloud (Web Speech synthesis), font scaling audit on 5-year-old Android devices.
12. Analytics: do we want privacy-preserving usage metrics (no content) to tune quick replies? If so, where do they live?
13. `AIPage` (job history) vs assistant duplication: should job creation funnel through the assistant thread instead of a separate page? Product decision pending.

## Implementation record (this slice)

See `REFACTOR.md → Phase 12` for files, migrations (none), tests run and results. In short:

- `packages/domain/src/red-flag.ts` (+ export) — shared deterministic red-flag detection (10 unit tests).
- `packages/ui` — `ConversationPanel` v2 (audience badge, quick-reply chips, emergency card, failed+retry,
  AI-assistant role label, multi-line output, data-message-role) + CSS (tokens) + type export.
- `apps/api` — `POST /api/v1/ai/chat` (mode derived from session; `requireStaff`+clinical role for provider
  mode; patientId for patient mode; rate limit `ai.chat` 30/10min; `withActor` audit `ai.chat.turn`
  metadata-only; server-side red-flag gate pre-empts inference; system prompts per audience; fail-closed via
  `assertIntegrationAvailable`; no chart injection; deterministic crisis reply).
- `apps/web` — `AIChatPage` rewrite (mode from route: `/ai/chat` provider, `/portal/assistant` patient;
  audience badge + dual-role re-confirmed switcher; per-audience greeting/chips/disclaimers; chips call the
  API; offline notice + manual retry; `/public/ai/status` gating; honest unconfigured state), nav entry
  `portal-assistant` (patientOnly) + `ai-chat` retitled "AI assistant" with widened clinical roles; route
  additions in `App.tsx`; `.mv-audience-switch` styles; staff nav role set widened to match API.
- `tests/e2e` — patient assistant responsive test (320→1366) + provider audience-badge assertion.
- **Not built / not claimed** — see Sections 4 & 7 (voice, photo, symptom card, triage scoring card,
  medication card, appointment deep-link card, patient→clinician escalation backend, chart grounding,
  conversation persistence, multilingual detection). `FEATURE_AI=false` in production; sandbox works locally.

## Acceptance evidence

```bash
npm run typecheck                      # tsc --noEmit — clean
npx eslint <changed files>             # clean
npx vitest run tests/unit/red-flag.test.ts   # 10/10 pass
npm test                               # 927/927 pass (101 files)
npx vitest run tests/integration/ai-chat.test.ts   # 7/7 pass (local Ollama stub)
```
