import { describe, it, expect } from "vitest";
import {
  DATE_LINE_RE,
  CWD_LINE_RE,
  frozenDate,
  frozenCwd,
  isDateFrozen,
  isCwdFrozen,
  applyDateFreeze,
  applyCwdFreeze,
} from "../lib/helpers.js";

// ═══════════════════════════════════════════════════════════════════════════
// Simulated pi system prompt (matching real pi output)
// ═══════════════════════════════════════════════════════════════════════════

const realPiPromptEnd = `
Current date: 2026-06-20
Current working directory: /Users/rhafid/.pi`;

const frozenPiPromptEnd = `
Current date: 2026-06-20 (frozen)
Current working directory: /Users/rhafid/.pi`;

// ═══════════════════════════════════════════════════════════════════════════
// DATE_LINE_RE
// ═══════════════════════════════════════════════════════════════════════════

describe("DATE_LINE_RE", () => {
  it("matches real pi date line", () => {
    const match = realPiPromptEnd.match(DATE_LINE_RE);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("2026-06-20");
  });

  it("matches frozen date line", () => {
    const match = frozenPiPromptEnd.match(DATE_LINE_RE);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("2026-06-20");
    expect(match![0]).toContain("(frozen)");
  });

  it("matches various valid dates", () => {
    const dates = [
      "Current date: 2024-01-01",
      "Current date: 2025-12-31",
      "Current date: 2026-06-15",
    ];
    for (const d of dates) {
      expect(d.match(DATE_LINE_RE)).not.toBeNull();
    }
  });

  it("does not match non-date strings", () => {
    // The regex validates \d{4}-\d{2}-\d{2} format, not calendar validity.
    // It will match syntactically valid patterns even if months/days are invalid.
    expect("Current date: abc-def-gh".match(DATE_LINE_RE)).toBeNull();
    expect("Other date: 2026-06-20".match(DATE_LINE_RE)).toBeNull();
    expect("Current date:".match(DATE_LINE_RE)).toBeNull();
    expect("No date here".match(DATE_LINE_RE)).toBeNull();
  });

  it("matches any \d{4}-\d{2}-\d{2} pattern (loose validation)", () => {
    // The regex intentionally uses loose matching — pi's own prompt builder
    // always produces valid dates, so strict calendar validation isn't needed.
    expect("Current date: 2026-13-01".match(DATE_LINE_RE)).not.toBeNull();
    expect("Current date: 2026-00-01".match(DATE_LINE_RE)).not.toBeNull();
  });

  it("matches date even when followed by CWD line (no $ anchor)", () => {
    const prompt = "Current date: 2026-06-20\nCurrent working directory: /tmp";
    const match = prompt.match(DATE_LINE_RE);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("2026-06-20");
  });

  it("captures only the date (group 1), not the frozen suffix", () => {
    const match = "Current date: 2026-06-20 (frozen)".match(DATE_LINE_RE);
    expect(match![1]).toBe("2026-06-20"); // not "2026-06-20 (frozen)"
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CWD_LINE_RE
// ═══════════════════════════════════════════════════════════════════════════

describe("CWD_LINE_RE", () => {
  it("matches real pi CWD line at end of prompt", () => {
    const match = realPiPromptEnd.match(CWD_LINE_RE);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("/Users/rhafid/.pi");
  });

  it("matches various paths", () => {
    const paths = [
      "Current working directory: /tmp",
      "Current working directory: /home/user/project",
      "Current working directory: C:\\Users\\name\\project",
      "Current working directory: /very/long/path/with/many/segments",
    ];
    for (const p of paths) {
      const match = p.match(CWD_LINE_RE);
      expect(match).not.toBeNull();
    }
  });

  it("captures path with spaces", () => {
    const match = "Current working directory: /path/with some spaces".match(CWD_LINE_RE);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("/path/with some spaces");
  });

  it("does not capture trailing whitespace", () => {
    const match = "Current working directory: /tmp  ".match(CWD_LINE_RE);
    expect(match![1]).toBe("/tmp"); // no trailing spaces
  });

  it("matches CWD when it is the last line ($ anchor)", () => {
    // CWD is always the last line in pi's system prompt
    const prompt = "Some content\nCurrent date: 2026-06-20\nCurrent working directory: /tmp";
    const match = prompt.match(CWD_LINE_RE);
    expect(match).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// frozenDate / frozenCwd
// ═══════════════════════════════════════════════════════════════════════════

describe("frozenDate", () => {
  it("produces the correct format", () => {
    expect(frozenDate("2026-06-20")).toBe("Current date: 2026-06-20 (frozen)");
  });
});

describe("frozenCwd", () => {
  it("produces the correct format", () => {
    expect(frozenCwd("/tmp")).toBe("Current working directory: /tmp");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// isDateFrozen / isCwdFrozen
// ═══════════════════════════════════════════════════════════════════════════

describe("isDateFrozen", () => {
  it("returns true when date is already frozen to expected date", () => {
    expect(isDateFrozen(frozenPiPromptEnd, "2026-06-20")).toBe(true);
  });

  it("returns false when date is not frozen", () => {
    expect(isDateFrozen(realPiPromptEnd, "2026-06-20")).toBe(false);
  });

  it("returns false when date is frozen to a different date", () => {
    const prompt = "Current date: 2026-06-19 (frozen)\nCurrent working directory: /tmp";
    expect(isDateFrozen(prompt, "2026-06-20")).toBe(false);
  });

  it("returns false when no date line exists", () => {
    expect(isDateFrozen("no date here", "2026-06-20")).toBe(false);
  });

  it("handles prompt with only a date line (no CWD)", () => {
    // Edge case: what if CWD_RE doesn't match but date does?
    const prompt = "Current date: 2026-06-20 (frozen)";
    expect(isDateFrozen(prompt, "2026-06-20")).toBe(true);
  });
});

describe("isCwdFrozen", () => {
  it("returns true when CWD matches expected path", () => {
    expect(isCwdFrozen(realPiPromptEnd, "/Users/rhafid/.pi")).toBe(true);
  });

  it("returns false when CWD differs from expected path", () => {
    expect(isCwdFrozen(realPiPromptEnd, "/different/path")).toBe(false);
  });

  it("returns false when no CWD line exists", () => {
    expect(isCwdFrozen("no cwd here", "/tmp")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// applyDateFreeze / applyCwdFreeze — idempotency
// ═══════════════════════════════════════════════════════════════════════════

describe("applyDateFreeze", () => {
  it("adds frozen marker to unfrozen date", () => {
    const result = applyDateFreeze("Current date: 2026-06-20\nCurrent working directory: /tmp", "2026-06-20");
    expect(result).toContain("Current date: 2026-06-20 (frozen)");
    expect(result).toContain("Current working directory: /tmp");
  });

  it("is idempotent — applying twice produces same result", () => {
    const prompt = "Current date: 2026-06-20\nCurrent working directory: /tmp";
    const first = applyDateFreeze(prompt, "2026-06-20");
    const second = applyDateFreeze(first, "2026-06-20");
    expect(second).toBe(first);
  });

  it("updates date when different from frozen", () => {
    const prompt = "Current date: 2026-06-19\nCurrent working directory: /tmp";
    const result = applyDateFreeze(prompt, "2026-06-20");
    expect(result).toContain("Current date: 2026-06-20 (frozen)");
  });
});

describe("applyCwdFreeze", () => {
  it("replaces CWD with frozen path", () => {
    const result = applyCwdFreeze(
      "Current date: 2026-06-20\nCurrent working directory: /old/path",
      "/new/path"
    );
    expect(result).toContain("Current working directory: /new/path");
    expect(result).toContain("Current date: 2026-06-20");
  });

  it("is idempotent", () => {
    const prompt = "Current date: 2026-06-20\nCurrent working directory: /tmp";
    const first = applyCwdFreeze(prompt, "/tmp");
    const second = applyCwdFreeze(first, "/tmp");
    expect(second).toBe(first);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration: end-to-end freeze on simulated pi prompt
// ═══════════════════════════════════════════════════════════════════════════

describe("full system prompt freeze (integration)", () => {
  const sessionDate = "2026-06-20";
  const sessionCwd = "/Users/rhafid/.pi";

  it("freezes date and CWD in one pass", () => {
    const prompt = realPiPromptEnd;
    let result = applyDateFreeze(prompt, sessionDate);
    result = applyCwdFreeze(result, sessionCwd);

    expect(isDateFrozen(result, sessionDate)).toBe(true);
    expect(isCwdFrozen(result, sessionCwd)).toBe(true);
  });

  it("double-freeze is safe", () => {
    const prompt = realPiPromptEnd;
    let result = applyDateFreeze(prompt, sessionDate);
    result = applyCwdFreeze(result, sessionCwd);
    const frozen = result;

    // Applying again should not change anything
    result = applyDateFreeze(frozen, sessionDate);
    result = applyCwdFreeze(frozen, sessionCwd);
    expect(result).toBe(frozen);
  });

  it("frozen prompt is byte-identical across multiple calls", () => {
    const a = applyCwdFreeze(applyDateFreeze(realPiPromptEnd, sessionDate), sessionCwd);
    const b = applyCwdFreeze(applyDateFreeze(realPiPromptEnd, sessionDate), sessionCwd);
    expect(a).toBe(b);
  });

  it("preserves non-date/CWD content", () => {
    const prefix = "You are an expert coding assistant.\n\nAvailable tools:\n- read\n- bash\n- edit\n\n";
    const prompt = prefix + realPiPromptEnd;
    const result = applyCwdFreeze(applyDateFreeze(prompt, sessionDate), sessionCwd);
    expect(result).toContain(prefix.trim());
    expect(result).toContain("Current date: 2026-06-20 (frozen)");
    expect(result).toContain(`Current working directory: ${sessionCwd}`);
  });
});
