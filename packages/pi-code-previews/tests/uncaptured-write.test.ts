import { describe, expect, it } from "vitest";
import {
  projectBuiltinCompactSummary,
  type BuiltinCompactProjectionInput,
} from "../src/tools/builtin-projection";

const base: BuiltinCompactProjectionInput = {
  phase: "settled",
  args: { path: "file.ts", content: "saved content" },
  result: { content: [{ type: "text", text: "Written" }], details: {} },
  cwd: "/workspace",
  isError: false,
  beforeWrite: { kind: "unknown" },
  secretWarnings: true,
  bashWarnings: true,
  secretScanChars: 8_000,
  maxWriteDiffBytes: 100_000,
  maxWriteDiffChangedLineCells: 10_000,
};

const noticeCodes = (input: BuiltinCompactProjectionInput) => {
  const summary = projectBuiltinCompactSummary("write", input)!;
  return {
    outcome: summary.outcome,
    notices: summary.notices ?? [],
    codes: summary.notices?.map((notice) => notice.code) ?? [],
  };
};

describe("explicit uncaptured write history", () => {
  it("uses expanded-only information for intentional absence", () => {
    const projected = noticeCodes({ ...base, beforeWrite: { kind: "not-captured" } });
    expect(projected.outcome).toBe("success");
    expect(projected.notices).toContainEqual(
      expect.objectContaining({
        code: "write-diff-not-captured",
        kind: "recovery",
        expandedOnly: true,
      }),
    );
    expect(projected.notices.some((notice) => notice.kind === "warning")).toBe(false);
  });

  it("keeps unknown and failed snapshot history as warnings", () => {
    const unknown = noticeCodes(base);
    expect(unknown.outcome).toBe("warning");
    expect(unknown.codes).toContain("write-history-unavailable");

    const failedSnapshot = noticeCodes({
      ...base,
      beforeWrite: {
        kind: "snapshot",
        value: {
          kind: "skipped",
          reason: "previous content unavailable",
          maxBytes: 100_000,
        },
      },
    });
    expect(failedSnapshot.outcome).toBe("warning");
    expect(failedSnapshot.codes).toContain("write-diff-skipped");
  });

  it("does not hide secret, edit, or write-failure attention", () => {
    const secret = noticeCodes({
      ...base,
      args: { path: "file.ts", content: "-----BEGIN PRIVATE KEY-----" },
      beforeWrite: { kind: "not-captured" },
    });
    expect(secret.outcome).toBe("warning");
    expect(secret.codes).toContain("possible-secrets");

    const edit = projectBuiltinCompactSummary("edit", {
      ...base,
      args: { path: "file.ts", oldText: "before", newText: "after" },
      beforeWrite: { kind: "not-captured" },
    });
    expect(edit?.outcome).toBe("warning");
    expect(edit?.notices?.map((notice) => notice.code)).toContain("edit-diff-unavailable");

    const failed = projectBuiltinCompactSummary("write", {
      ...base,
      isError: true,
      beforeWrite: { kind: "not-captured" },
      result: {
        content: [{ type: "text", text: "Write failed. Inspect filesystem state." }],
        details: {},
      },
    });
    expect(failed?.outcome).toBe("error");
    expect(failed?.failure).toBeDefined();
  });
});
