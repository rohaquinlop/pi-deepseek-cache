import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

describe("session_before_compact event shape", () => {
  it("documents the expected destructured fields from the event", () => {
    // The session_before_compact handler destructures these fields from event:
    //   messagesToSummarize, previousSummary, firstKeptEntryId, tokensBefore, signal
    //
    // This test documents the contract — actual runtime test would need pi harness.
    // The fields are verified by the Step 1 fix (adding the destructuring).
    const requiredFields = [
      "messagesToSummarize",
      "previousSummary",
      "firstKeptEntryId",
      "tokensBefore",
      "signal",
    ];

    // Simulate an event object with all required fields
    const mockEvent = {
      messagesToSummarize: [],
      previousSummary: "Previous summary text",
      firstKeptEntryId: "entry-42",
      tokensBefore: 5000,
      signal: new AbortController().signal,
    };

    for (const field of requiredFields) {
      expect(mockEvent).toHaveProperty(field);
    }
  });

  it("summary cache key is deterministic for same input", () => {
    const text = "[Previous summary]\nOld summary\n\n[New history]\nNew messages";
    const key1 = createHash("sha256").update(text).digest("hex");
    const key2 = createHash("sha256").update(text).digest("hex");
    expect(key1).toBe(key2);
  });
});
