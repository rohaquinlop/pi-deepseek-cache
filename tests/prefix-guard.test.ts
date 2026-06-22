import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

describe("prefix guard (P2)", () => {
  it("JSON.stringify determinism for prefix hashing", () => {
    // DeepSeek's prefix cache matches from byte position 0.
    // We hash msgs.slice(0, -1) to detect when prior messages change.
    // JSON.stringify must be deterministic for this check to work.
    const msgs = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const hash1 = createHash("sha256")
      .update(JSON.stringify(msgs.slice(0, -1)))
      .digest("hex");
    const hash2 = createHash("sha256")
      .update(JSON.stringify(msgs.slice(0, -1)))
      .digest("hex");
    expect(hash1).toBe(hash2);
  });

  it("different prefixes produce different hashes", () => {
    // slice(0, -1) drops the last message (the current user turn).
    // For hashes to differ, the preserved prefix must differ.
    const msgs1 = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hello" },
    ];
    const msgs2 = [
      { role: "system", content: "You are unhelpful." },
      { role: "user", content: "hello" },
    ];
    const hash1 = createHash("sha256")
      .update(JSON.stringify(msgs1.slice(0, -1)))
      .digest("hex");
    const hash2 = createHash("sha256")
      .update(JSON.stringify(msgs2.slice(0, -1)))
      .digest("hex");
    expect(hash1).not.toBe(hash2);
  });
});
