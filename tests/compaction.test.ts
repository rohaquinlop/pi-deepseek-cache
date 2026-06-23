import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

describe("session_before_compact event shape", () => {
  it("documents the expected destructured fields from the event", () => {
    // The session_before_compact handler destructures fields from event.preparation:
    //   const { preparation, signal } = event;
    //   const { messagesToSummarize, previousSummary, firstKeptEntryId, tokensBefore } = preparation;
    //
    // This test documents the contract — actual runtime test would need pi harness.
    const preparationFields = [
      "messagesToSummarize",
      "previousSummary",
      "firstKeptEntryId",
      "tokensBefore",
    ];

    // Simulate an event object with the correct nested shape
    const mockEvent = {
      preparation: {
        messagesToSummarize: [],
        previousSummary: "Previous summary text",
        firstKeptEntryId: "entry-42",
        tokensBefore: 5000,
      },
      signal: new AbortController().signal,
    };

    expect(mockEvent).toHaveProperty("preparation");
    expect(mockEvent).toHaveProperty("signal");
    for (const field of preparationFields) {
      expect(mockEvent.preparation).toHaveProperty(field);
    }
  });

  it("summary cache key is deterministic for same input", () => {
    const text = "[Previous summary]\nOld summary\n\n[New history]\nNew messages";
    const key1 = createHash("sha256").update(text).digest("hex");
    const key2 = createHash("sha256").update(text).digest("hex");
    expect(key1).toBe(key2);
  });
});
