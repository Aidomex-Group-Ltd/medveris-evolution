/**
 * Shared red-flag detection for the role-aware AI assistant.
 *
 * Deterministic, keyword/pattern based. Used on the client to interrupt the normal
 * chat flow with an emergency card, and on the server to (a) refuse to route a
 * red-flag message to the model and instead return a fixed, safe response and
 * (b) flag the turn in audit metadata. It is a safety net, not a diagnosis and
 * not a triage of record; the UI copy must always direct the user to emergency
 * services and a clinician.
 *
 * Client and server share this module so the two never disagree on what counts
 * as a red flag. Patterns are English-first with a few common variants; locale
 * coverage is an open question (see docs/refactor/phase12).
 */

export type RedFlagCategory =
  | "chest_pain"
  | "stroke"
  | "severe_bleeding"
  | "breathing"
  | "anaphylaxis"
  | "self_harm"
  | "loss_of_consciousness"
  | "severe_allergic_reaction";

export interface RedFlagMatch {
  category: RedFlagCategory;
  /** Human label, safe to show. Never contains the user's text. */
  label: string;
}

const RULES: ReadonlyArray<{ category: RedFlagCategory; label: string; patterns: readonly RegExp[] }> = [
  {
    category: "chest_pain",
    label: "Possible heart problem",
    patterns: [
      /chest\s+(?:pain|pressure|tightness|discomfort|heaviness)/i,
      /pain\s+(?:in|across)\s+(?:my\s+)?(?:the\s+)?(?:chest|left\s+arm)/i,
      /crushing\s+(?:pain|sensation|pressure)/i,
      /heart\s+attack/i,
    ],
  },
  {
    category: "stroke",
    label: "Possible stroke",
    patterns: [
      /(?:face|facial)[^.]{0,40}(?:droop|numb)/i,
      /(?:sudden|sudden\s+onset)\s+(?:weakness|numbness)/i,
      /(?:arm|leg)\s+(?:weak(?:ness)?|numb(?:ness)?)\s*(?:on\s+one\s+side)?/i,
      /slurred\s+speech|speech\s+(?:is\s+)?(?:suddenly\s+|so\s+)?slurred/i,
      /cannot\s+speak|can\s*not\s+speak/i,
      /sudden\s+(?:severe\s+)?(?:worst\s+)?headache/i,
      /(?:vision|loss\s+of\s+vision)\s*(?:loss|change|sudden)/i,
      /\bstroke\b/i,
    ],
  },
  {
    category: "severe_bleeding",
    label: "Severe bleeding",
    patterns: [
      /(?:heavy|severe|uncontrollable|profuse|won't\s+stop)\s+bleed(?:ing)?/i,
      /bleed(?:ing)?\s+(?:heavily|severely|uncontrollably|a\s+lot)/i,
      /(?:cough(?:ing)?\s+(?:up\s+)?|vomit(?:ing)?|throwing\s+up)\s*(?:a\s+lot\s+of\s+)?blood/i,
      /blood\s+(?:everywhere|pool(?:ing)?)/i,
    ],
  },
  {
    category: "breathing",
    label: "Breathing difficulty",
    patterns: [
      /(?:can(?:'|no)?t|cannot|struggling\s+to|difficulty|hard\s+to|unable\s+to)\s+breathe/i,
      /short(?:ness)?\s+of\s+breath/i,
      /(?:gasping|wheezing|choking)/i,
      /lips?[^.]{0,20}blue/i,
      /(?:severe|silent)\s+asthma/i,
    ],
  },
  {
    category: "anaphylaxis",
    label: "Possible severe allergic reaction",
    patterns: [
      /anaphyla(?:xis|ctic)/i,
      /(?:throat|tongue|lips)\s+(?:swelling|closing|tight)/i,
      /swelling\s+of\s+(?:the\s+)?(?:throat|tongue)/i,
      /epipen/i,
    ],
  },
  {
    category: "severe_allergic_reaction",
    label: "Possible severe allergic reaction",
    patterns: [
      /(?:hives|rash)\s+(?:all\s+over|everywhere)/i,
      /(?:dizzy|faint)\s+(?:after|following)\s+(?:a\s+)?(?:bee|wasp|sting|food|medicine|drug)/i,
    ],
  },
  {
    category: "self_harm",
    label: "Possible self-harm or suicidal thoughts",
    patterns: [
      /suicid(?:e|al)/i,
      /kill(?:ing)?\s+myself/i,
      /end(?:ing)?\s+(?:my|it|life)/i,
      /(?:want(?:ing)?|plan(?:ning)?)\s+to\s+(?:die|end\s+it|end\s+my\s+life)/i,
      /self[- ]?harm/i,
      /(?:hurt|harm)\s+myself/i,
      /no(?:thing)?\s+to\s+live\s+for/i,
      /better\s+off\s+(?:dead|without\s+me)/i,
    ],
  },
  {
    category: "loss_of_consciousness",
    label: "Loss of consciousness",
    patterns: [
      /(?:passed|faint(?:ed)?|black(?:ed)?)\s*out/i,
      /loss\s+of\s+consciousness/i,
      /unresponsive|not\s+responding|won't\s+wake/i,
      /(?:seizure|convulsion)/i,
    ],
  },
];

/** Returns the matching red-flag category, or null when none is detected. */
export function detectRedFlag(text: string): RedFlagMatch | null {
  const input = (text ?? "").slice(0, 4000);
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(input)) return { category: rule.category, label: rule.label };
    }
  }
  return null;
}

/** True when any of the given messages trips a red flag. */
export function containsRedFlag(messages: readonly { content: string }[]): boolean {
  return messages.some((message) => detectRedFlag(message.content) !== null);
}
