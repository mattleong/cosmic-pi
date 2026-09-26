import { describe, expect, it } from "vitest";
import {
  projectBuiltinCompactSummary,
  type BuiltinCompactProjectionInput,
} from "../../src/tools/builtin-projection";

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
  it("provides bounded semantic failure evidence only for recognized complete native errors", () => {
    for (const [tool, text, code] of [
      [
        "bash",
        "SOURCE_SNIPPET\nError: diagnostic\n  at some stack\nCommand exited with code 1",
        "shell-exit",
      ],
      [
        "edit",
        "Found 4 occurrences of edits[3] in secret-file. Each oldText must be unique. Please provide more context to make it unique.",
        "edit-ambiguous",
      ],
      [
        "edit",
        "Could not find edits[2] in secret-file. The oldText must match exactly including all whitespace and newlines.",
        "edit-no-match",
      ],
      [
        "edit",
        "edits[0] and edits[1] overlap in secret-file. Merge them into one edit or target disjoint regions.",
        "edit-overlap",
      ],
    ] as const) {
      const summary = projectBuiltinCompactSummary(tool, {
        ...base,
        isError: true,
        result: { content: [{ type: "text", text }], details: {} },
      });
      expect(summary?.failureEvidence).toMatchObject({ code, coverage: "complete" });
      expect(summary?.failureEvidence?.cause).not.toMatch(
        /SOURCE_SNIPPET|secret-file|at some stack/u,
      );
      expect(summary?.failure?.details).toBe(text);
    }
    const unknown = projectBuiltinCompactSummary("edit", {
      ...base,
      isError: true,
      result: {
        content: [
          { type: "text", text: "Unrecognized failure. Inspect remote state before retrying." },
        ],
        details: {},
      },
    });
    expect(unknown?.failureEvidence).toBeUndefined();
    expect(unknown?.failure?.cause).toContain("Inspect remote state");
    const continuation = projectBuiltinCompactSummary("read", {
      ...base,
      isError: true,
      result: {
        content: [
          {
            type: "text",
            text: "ENOENT: no such file or directory, file\nPartial changes may exist. Verify state.",
          },
        ],
        details: {},
      },
    });
    expect(continuation?.failureEvidence?.coverage).toBe("unknown");
    expect(continuation?.notices?.some((notice) => notice.text.includes("Verify state"))).toBe(
      true,
    );
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
  });
});

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
