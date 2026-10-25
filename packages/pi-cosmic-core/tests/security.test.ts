import { describe, expect, it } from "vitest";
import {
  hasControlCharacter,
  maskIdentifier,
  redactDiagnosticValue,
  sanitizeDiagnosticContent,
  sanitizeDiagnosticError,
  stripTerminalControls,
} from "../src/security.ts";

describe("control character detection", () => {
  it("recognizes every C0, DEL, and C1 control code point", () => {
    const ranges = [
      [0x00, 0x1f],
      [0x7f, 0x9f],
    ] as const;

    for (const [start, end] of ranges) {
      for (let codePoint = start; codePoint <= end; codePoint += 1) {
        expect(hasControlCharacter(String.fromCodePoint(codePoint))).toBe(true);
      }
    }
  });
});

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

  it("removes SGR, C1 control sequences, and terminal strings", () => {
    const styled =
      "\u001b[31;1mred\u001b[0m" +
      "\u001b[2J" +
      "visible" +
      "\u001b]52;c;Y2xpcA==\u0007" +
      "\u009b38;5;42mgreen\u009b0m";
    expect(stripTerminalControls(styled)).toBe("redvisiblegreen");
  });

  it("redacts nested fields and masks display identifiers", () => {
    expect(
      redactDiagnosticValue({ auth: "secret", nested: { refresh_token: "token", ok: 1 } }),
    ).toEqual({ auth: "[REDACTED]", nested: { refresh_token: "[REDACTED]", ok: 1 } });
    const sparse = [1];
    sparse[2] = 3;
    expect(redactDiagnosticValue({ sparse })).toEqual({ sparse: [1, null, 3] });
    expect(maskIdentifier("account-123456789")).toBe("acco...6789");
  });
});
