import { describe, expect, it } from "vitest";
import { sanitizeDiagnosticText, sanitizeOutputText } from "../src/run/state.ts";
import { appendTranscript } from "../src/run/transcript.ts";
import { sanitizeTerminalText } from "../src/ui/sanitize.ts";

describe("subagent transcript", () => {
  it("bounds retained lines", () => {
    const bounded = appendTranscript(
      [],
      Array.from({ length: 700 }, (_, index) => `line-${index}`).join("\n"),
    );
    expect(bounded).toHaveLength(500);
    expect(bounded[0]).toBe("line-200");
  });

  it("removes terminal controls and redacts diagnostic secrets", () => {
    expect(sanitizeTerminalText("\u001b[31mred\u001b[0m\nplain")).toBe("red\nplain");
    expect(sanitizeOutputText("\u001b[31mresult\u001b[0m", 100)).toBe("result");
    expect(sanitizeDiagnosticText("token=secret-value", 100)).toBe("token=[REDACTED]");
  });
});
