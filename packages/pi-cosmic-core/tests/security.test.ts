import { describe, expect, it } from "vitest";
import {
  maskIdentifier,
  redactDiagnosticValue,
  sanitizeDiagnosticContent,
  sanitizeDiagnosticError,
  sanitizeTerminalStyledFragments,
  sanitizeTerminalStyledText,
  stripTerminalControls,
} from "../index.ts";

describe("security formatting", () => {
  it("redacts provider credentials and identifiers", () => {
    const message = sanitizeDiagnosticError(
      "Bearer secret-token sk-abcdefgh accountId=acct_123456789 teamId=team_123456789",
    );
    expect(message).not.toContain("secret-token");
    expect(message).not.toContain("abcdefgh");
    expect(message).not.toContain("123456789");
    expect(message).toContain("[REDACTED]");
  });

  it("preserves Markdown whitespace while redacting content", () => {
    expect(sanitizeDiagnosticContent("- parent\n  - child\n\n    token=secret-value\n\tcode")).toBe(
      "- parent\n  - child\n\n    token=[REDACTED]\n\tcode",
    );
  });

  it("redacts common explicit secret assignments", () => {
    const content = sanitizeDiagnosticContent(
      'password=hunter2\nsecret: abc123\nprivate_key="key value"\ncredential=usable',
    );
    expect(content).toBe(
      "password=[REDACTED]\nsecret: [REDACTED]\nprivate_key=[REDACTED]\ncredential=[REDACTED]",
    );
  });

  it("removes complete terminal control strings while preserving Markdown", () => {
    expect(stripTerminalControls("- item\n  code\u001b]52;c;Y2xpcA==\u0007\n\tmore")).toBe(
      "- item\n  code\n\tmore",
    );
  });

  it("preserves only safe visual SGR sequences for styled terminal output", () => {
    const styled =
      "\u001b[31;1mred\u001b[0m" +
      "\u001b[2J" +
      "visible" +
      "\u001b]52;c;Y2xpcA==\u0007" +
      "\u009b38;5;42mgreen\u009b0m";
    expect(sanitizeTerminalStyledText(styled)).toBe(
      "\u001b[31;1mred\u001b[0mvisible\u001b[38;5;42mgreen\u001b[0m",
    );
    expect(stripTerminalControls(styled)).toBe("redvisiblegreen");
  });

  it("drops malformed or unbounded SGR sequences", () => {
    expect(sanitizeTerminalStyledText("a\u001b[31?mb")).toBe("ab");
    expect(sanitizeTerminalStyledText("a\u001b[38:5:42mb")).toBe("ab");
    expect(sanitizeTerminalStyledText(`a\u001b[${"1".repeat(129)}mb`)).toBe("ab");
    const flooded = sanitizeTerminalStyledText(`${"\u001b[31m".repeat(1_000)}visible`);
    expect(flooded.split("\u001b[")).toHaveLength(258);
    expect(stripTerminalControls(flooded)).toBe("visible");
    expect(
      sanitizeTerminalStyledText(`${"\u001b[31m".repeat(1_000)}first\n\u001b[32mnext`),
    ).toContain("\n\u001b[32mnext");
  });

  it("revisits nested control introducers instead of exposing terminal-string payloads", () => {
    expect(sanitizeTerminalStyledText("\u001b\u009d52;c;SECRET\u0007visible")).toBe("visible");
    expect(sanitizeTerminalStyledText("\u001b\u001b]0;SECRET\u0007visible")).toBe("visible");
    expect(sanitizeTerminalStyledText("\u001b[\u001b]0;SECRET\u0007visible")).toBe("visible");
    expect(sanitizeTerminalStyledText("\u009b\u009d52;c;SECRET\u0007visible")).toBe("visible");
  });

  it("retains parser and compact SGR state independently across interleaved fragments", () => {
    const fragments = sanitizeTerminalStyledFragments([
      { channel: "stdout", text: "\u001b[3" },
      { channel: "stderr", text: "oops\n" },
      { channel: "stdout", text: "1mred\n" },
      { channel: "stderr", text: "again\n" },
      { channel: "stdout", text: "still red\u001b[;mplain" },
    ]);
    expect(fragments.map(({ channel, text, reopenSgr }) => ({ channel, text, reopenSgr }))).toEqual(
      [
        { channel: "stdout", text: "", reopenSgr: "" },
        { channel: "stderr", text: "oops\n", reopenSgr: "" },
        { channel: "stdout", text: "\u001b[31mred\n", reopenSgr: "" },
        { channel: "stderr", text: "again\n", reopenSgr: "" },
        {
          channel: "stdout",
          text: "still red\u001b[0;0mplain",
          reopenSgr: "\u001b[31m",
        },
      ],
    );
  });

  it("normalizes horizontal tabs to inert spaces in styled terminal output", () => {
    const styled = sanitizeTerminalStyledText("one\ttwo");
    expect(styled).toBe("one   two");
    expect(styled).not.toContain("\t");
  });

  it("shares one SGR traffic budget across same-line fragments", () => {
    const fragments = sanitizeTerminalStyledFragments(
      Array.from({ length: 100 }, () => ({
        channel: "stdout",
        text: `${"\u001b[31m".repeat(300)}x`,
      })),
    );
    const styled = fragments.map((fragment) => fragment.text).join("");
    expect(styled.split("\u001b[").length).toBeLessThanOrEqual(258);
    expect(stripTerminalControls(styled)).toBe("x".repeat(100));
  });

  it("redacts nested fields and masks display identifiers", () => {
    expect(
      redactDiagnosticValue({ auth: "secret", nested: { refresh_token: "token", ok: 1 } }),
    ).toEqual({ auth: "[REDACTED]", nested: { refresh_token: "[REDACTED]", ok: 1 } });
    expect(maskIdentifier("account-123456789")).toBe("acco...6789");
  });
});
