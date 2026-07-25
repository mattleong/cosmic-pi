import { describe, expect, it } from "vitest";
import {
  maskIdentifier,
  redactDiagnosticValue,
  sanitizeDiagnosticContent,
  sanitizeDiagnosticError,
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

  it("redacts nested fields and masks display identifiers", () => {
    expect(
      redactDiagnosticValue({ auth: "secret", nested: { refresh_token: "token", ok: 1 } }),
    ).toEqual({ auth: "[REDACTED]", nested: { refresh_token: "[REDACTED]", ok: 1 } });
    expect(maskIdentifier("account-123456789")).toBe("acco...6789");
  });
});
