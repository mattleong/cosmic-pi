import { describe, expect, it } from "vitest";
import {
  projectBuiltinCompactSummary,
  type BuiltinCompactProjectionInput,
} from "../../src/tools/builtin-projection";
import { captureBuiltinCompactPolicy } from "../../src/tools/builtin-compact-summary";

const base: BuiltinCompactProjectionInput = {
  phase: "settled",
  args: { path: "file.ts", content: "hello" },
  result: { content: [{ type: "text", text: "Written" }], details: {} },
  cwd: "/workspace",
  isError: false,
  beforeWrite: { kind: "unknown" },
  secretWarnings: true,
  bashWarnings: true,
  secretScanChars: 8000,
  maxWriteDiffBytes: 100000,
  maxWriteDiffChangedLineCells: 10000,
};

describe("transient builtin projection", () => {
  it("distinguishes unknown before-write history from explicit absent-file evidence", () => {
    const unknown = projectBuiltinCompactSummary("write", base)!;
    expect(unknown.counters).not.toContain("new file");
    expect(unknown.notices?.length).toBeGreaterThan(0);
    const created = projectBuiltinCompactSummary("write", {
      ...base,
      beforeWrite: { kind: "new" },
    })!;
    expect(created.counters).toContain("new file");
    expect(created.notices).toEqual([]);
    const changed = projectBuiltinCompactSummary("write", {
      ...base,
      beforeWrite: { kind: "snapshot", value: { kind: "content", content: "before" } },
    })!;
    expect(changed.counters?.length).toBeGreaterThan(0);
    expect(changed.notices).toEqual([]);
  });

  it("uses explicit secret policy and does not mutate retained inputs", () => {
    const input = Object.freeze({
      ...base,
      args: Object.freeze({ path: "file.ts", content: "-----BEGIN PRIVATE KEY-----" }),
      beforeWrite: { kind: "new" as const },
    });
    expect(projectBuiltinCompactSummary("write", input)?.notices?.length).toBeGreaterThan(0);
    expect(
      projectBuiltinCompactSummary("write", { ...input, secretWarnings: false })?.notices,
    ).toEqual([]);
    const policy = captureBuiltinCompactPolicy();
    policy.secretWarnings = !policy.secretWarnings;
    expect(captureBuiltinCompactPolicy().secretWarnings).not.toBe(policy.secretWarnings);
  });

  it("preserves limit attention and declines unsafe partial projections", () => {
    const result = {
      content: [{ type: "text" as const, text: "a.ts:1: match" }],
      details: { matchLimitReached: 8, linesTruncated: true },
    };
    const summary = projectBuiltinCompactSummary("grep", { ...base, result });
    expect(summary?.counters).toContain("limit reached: 8");
    expect(summary?.notices?.some((notice) => notice.kind === "recovery")).toBe(true);
    expect(
      projectBuiltinCompactSummary("bash", { ...base, args: { command: "x".repeat(17000) } }),
    ).toBeUndefined();
    expect(
      projectBuiltinCompactSummary("read", {
        ...base,
        result: {
          content: [{ type: "text", text: "unrecognized truncated output" }],
          details: { truncation: { truncated: true } },
        },
      }),
    ).toBeUndefined();
  });

  it("keeps complete standalone failure text transient and attachment failures unclaimed", () => {
    const summary = projectBuiltinCompactSummary("read", {
      ...base,
      isError: true,
      result: {
        content: [{ type: "text", text: "Unexpected failure\nCheck state before replay" }],
        details: {},
      },
    });
    expect(summary?.failure?.details).toContain("Check state before replay");
    expect(
      projectBuiltinCompactSummary("read", {
        ...base,
        isError: true,
        result: { content: [{ type: "image", data: "AA==", mimeType: "image/png" }], details: {} },
      }),
    ).toBeUndefined();
  });
});
