import { describe, expect, it } from "vitest";
import {
  canTransitionEncounter,
  canTransitionFollowUp,
  canTransitionReferral,
  canonicalJson,
  contentDigest,
  isPatientPublicId,
  nextEntryStatus,
  randomPatientPublicId,
} from "@medveris/domain";

describe("patient public identifier", () => {
  it("is randomized, non-sequential and matches the transcription-safe alphabet", () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomPatientPublicId()));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^MV-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(isPatientPublicId(id)).toBe(true);
    }
  });

  it("rejects ambiguous characters", () => {
    expect(isPatientPublicId("MV-IIII-1111-OOOO-0000")).toBe(false);
  });
});

describe("clinical entry state machine", () => {
  it("permits draft to signed only", () => {
    expect(nextEntryStatus("draft", "sign")).toBe("signed");
    expect(() => nextEntryStatus("signed", "sign")).toThrow();
    expect(() => nextEntryStatus("amended", "sign")).toThrow();
  });

  it("permits reasoned amendments only after signing", () => {
    expect(nextEntryStatus("signed", "amend")).toBe("amended");
    expect(nextEntryStatus("amended", "amend")).toBe("amended");
    expect(() => nextEntryStatus("draft", "amend")).toThrow();
  });

  it("preserves signed history by transitioning to entered-in-error rather than deleting", () => {
    expect(nextEntryStatus("signed", "error")).toBe("entered-in-error");
    expect(() => nextEntryStatus("draft", "error")).toThrow();
  });
});

describe("encounter transitions", () => {
  it("enforces the outpatient pathway", () => {
    expect(canTransitionEncounter("planned", "arrived")).toBe(true);
    expect(canTransitionEncounter("arrived", "triaged")).toBe(true);
    expect(canTransitionEncounter("triaged", "in-progress")).toBe(true);
    expect(canTransitionEncounter("in-progress", "completed")).toBe(true);
    expect(canTransitionEncounter("completed", "in-progress")).toBe(false);
    expect(canTransitionEncounter("arrived", "completed")).toBe(false);
  });
});

describe("content digests", () => {
  it("is stable across object key order but sensitive to content changes", async () => {
    const first = await contentDigest({ title: "Note", plan: "Review" });
    const second = await contentDigest({ plan: "Review", title: "Note" });
    const changed = await contentDigest({ plan: "Review", title: "Note " });
    expect(first).toBe(second);
    expect(changed).not.toBe(first);
    expect(first.startsWith("sha256:")).toBe(true);
  });

  it("canonicalizes nested structures deterministically", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

describe("follow-up and referral tracking transitions", () => {
  it("keeps follow-ups terminal after a decision", () => {
    expect(canTransitionFollowUp("pending", "completed")).toBe(true);
    expect(canTransitionFollowUp("pending", "cancelled")).toBe(true);
    expect(canTransitionFollowUp("completed", "cancelled")).toBe(false);
    expect(canTransitionFollowUp("cancelled", "completed")).toBe(false);
  });

  it("allows referral completion only after local acceptance", () => {
    expect(canTransitionReferral("pending", "accepted")).toBe(true);
    expect(canTransitionReferral("pending", "declined")).toBe(true);
    expect(canTransitionReferral("accepted", "completed")).toBe(true);
    expect(canTransitionReferral("declined", "completed")).toBe(false);
    expect(canTransitionReferral("completed", "cancelled")).toBe(false);
  });
});
