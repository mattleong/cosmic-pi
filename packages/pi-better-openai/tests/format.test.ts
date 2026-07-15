import { describe, expect, test } from "vitest";
import { redactDiagnosticValue, stripAnsi, truncateToWidth, visibleWidth } from "../src/format.ts";

describe("format helpers", () => {
  test("truncates ansi-styled text to visible width", () => {
    const truncated = truncateToWidth("\u001b[2mabcdef\u001b[22m", 4);

    expect(stripAnsi(truncated)).toBe("a...");
    expect(visibleWidth(truncated)).toBe(4);
  });

  test("measures and truncates Unicode by terminal cell width", () => {
    expect(visibleWidth("界")).toBe(2);
    expect(visibleWidth("e\u0301")).toBe(1);
    expect(visibleWidth("🙂")).toBe(2);

    const truncated = truncateToWidth("🙂abcd", 5);
    expect(stripAnsi(truncated)).toBe("🙂...");
    expect(visibleWidth(truncated)).toBe(5);
  });

  test("redacts secret-like fields and embedded credentials in diagnostic values", () => {
    const redacted = redactDiagnosticValue({
      feature: true,
      customApiKey: "sk-secretsecret",
      auth: "opaque-auth-value",
      nested: {
        accountId: "acct_1234567890abcdef",
        refresh: "opaque-refresh-value",
        accessKey: "AKIAEXAMPLE",
        note: "Authorization: Bearer sk-anothersecret",
      },
    });

    expect(redacted).toEqual({
      feature: true,
      customApiKey: "[REDACTED]",
      auth: "[REDACTED]",
      nested: {
        accountId: "[REDACTED]",
        refresh: "[REDACTED]",
        accessKey: "[REDACTED]",
        note: "Authorization: [REDACTED] [REDACTED]",
      },
    });
  });
});
