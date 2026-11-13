import { describe, expect, it } from "vitest";
import { detectRedFlag, containsRedFlag } from "@medveris/domain";

describe("detectRedFlag", () => {
  it("returns null for ordinary, non-urgent phrasing", () => {
    expect(detectRedFlag("What time do the clinics open on Monday?")).toBeNull();
    expect(detectRedFlag("I would like to talk about my blood pressure medicine")).toBeNull();
    expect(detectRedFlag("Can you explain my lab result in simple words?")).toBeNull();
  });

  it("flags possible cardiac chest pain", () => {
    expect(detectRedFlag("I have chest pain and pressure since morning")?.category).toBe("chest_pain");
    expect(detectRedFlag("crushing chest pain radiating to my left arm")?.category).toBe("chest_pain");
  });

  it("flags possible stroke presentations", () => {
    expect(detectRedFlag("My face feels drooped and my speech is suddenly slurred")?.category).toBe("stroke");
    expect(detectRedFlag("sudden weakness on one side")?.category).toBe("stroke");
  });

  it("flags severe bleeding", () => {
    expect(detectRedFlag("I am bleeding heavily and it won't stop")?.category).toBe("severe_bleeding");
    expect(detectRedFlag("coughing up blood")?.category).toBe("severe_bleeding");
  });

  it("flags breathing difficulty including blue lips", () => {
    expect(detectRedFlag("I can't breathe properly")?.category).toBe("breathing");
    expect(detectRedFlag("my lips are turning blue")?.category).toBe("breathing");
  });

  it("flags anaphylaxis presentations", () => {
    expect(detectRedFlag("my throat is closing and I used my epipen")?.category).toBe("anaphylaxis");
  });

  it("flags self-harm and suicidal ideation", () => {
    expect(detectRedFlag("I want to kill myself")?.category).toBe("self_harm");
    expect(detectRedFlag("I have been thinking about suicide")?.category).toBe("self_harm");
    expect(detectRedFlag("everyone would be better off without me")?.category).toBe("self_harm");
  });

  it("flags loss of consciousness and seizures", () => {
    expect(detectRedFlag("she passed out and is not responding")?.category).toBe("loss_of_consciousness");
    expect(detectRedFlag("he is having a seizure")?.category).toBe("loss_of_consciousness");
  });

  it("does not match case-insensitively on benign lookalikes", () => {
    expect(detectRedFlag("my chest of drawers arrived today")).toBeNull();
  });

  it("containsRedFlag scans a conversation history", () => {
    expect(containsRedFlag([{ content: "hello" }, { content: "I have chest pain" }])).toBe(true);
    expect(containsRedFlag([{ content: "hello" }])).toBe(false);
  });
});
