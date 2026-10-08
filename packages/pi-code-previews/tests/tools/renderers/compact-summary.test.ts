import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { applyPresentationSettings, renderContextFixture } from "../../../testing";
import type {
  AgentToolResult,
  ReadToolInput,
  BashToolInput,
  WriteToolInput,
  EditToolInput,
  GrepToolInput,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { defaultCodePreviewSettings } from "../../../src/config/defaults";
import {
  codePreviewPerformanceConfig,
  codePreviewSettings,
  setCodePreviewPerformanceConfig,
  setCodePreviewSettings,
} from "../../../src/config/state";
import { createBuiltinCompactSummary } from "../../../src/tools/builtin-compact-summary";
import type { BuiltinCompactTool } from "../../../src/tools/builtin-subject";
import type { CompactPhase, CompactSummary } from "../../../src/tools/compact-summary";
import type { ToolRenderContext } from "../../../src/tools/renderers/shared/types";
import { readPreviewRenderers } from "../../../src/tools/renderers/read";
import {
  builtinRenderers,
  plainTheme as theme,
  previewBodiesDisabled,
  renderComponent,
  textResult as result,
} from "../../support/render";

const originalPerformance = codePreviewPerformanceConfig;
const secret = "-----BEGIN PRIVATE KEY-----";
type Args = Partial<
  ReadToolInput & BashToolInput & WriteToolInput & EditToolInput & GrepToolInput
> & {
  old_text?: string;
  new_text?: string;
};

beforeEach(() =>
  applyPresentationSettings({
    ...defaultCodePreviewSettings,
    toolCallCollapsedStyle: "compact",
    toolCallBackground: "off",
    toolCallTiming: false,
    ...previewBodiesDisabled,
    bashWarnings: true,
    secretWarnings: true,
  }),
);
afterEach(() => setCodePreviewPerformanceConfig(originalPerformance));

function summary(
  tool: BuiltinCompactTool,
  args: Args = { path: "src/example.ts" },
  resultValue: AgentToolResult<unknown> | undefined = undefined,
  phase: CompactPhase = resultValue ? "settled" : "pending",
  overrides: Partial<ToolRenderContext<{}, Args>> = {},
): CompactSummary | undefined {
  return createBuiltinCompactSummary(tool, {
    phase,
    args,
    result: resultValue,
    context: renderContextFixture({
      args,
      toolCallId: "compact-summary-test",
      argsComplete: phase !== "pending",
      executionStarted: phase === "running",
      isPartial: phase === "running",
      ...overrides,
    }),
  });
}

/** Issue codes of a defined summary, in display order. */
function codes(value: CompactSummary | undefined): string[] {
  expect(value).toBeDefined();
  return value?.issues?.map((issue) => issue.code) ?? [];
}

function issueFor(value: CompactSummary | undefined, code: string) {
  return value?.issues?.find((entry) => entry.code === code);
}

const tools: BuiltinCompactTool[] = ["read", "bash", "write", "edit", "grep", "find", "ls"];

test("builtin subjects use render cwd and never overflow requested read ranges", () => {
  expect(summary("read", { path: "/project/src/a.ts", offset: 2, limit: 3 })?.subject).toBe(
    "src/a.ts:2-4",
  );
  const overflow = summary("read", {
    path: "/project/src/a.ts",
    offset: Number.MAX_SAFE_INTEGER,
    limit: 2,
  });
  expect(overflow?.subject).toBe(`src/a.ts:${Number.MAX_SAFE_INTEGER}`);
  expect(summary("find", { path: "/project/src", pattern: "*.ts" })?.subject).toContain("src");
});

test.each([
  { offset: 2, limit: 3 },
  { offset: 5, limit: 0 },
  { offset: 5, limit: -3 },
  { limit: 2.5 },
  { offset: Number.MAX_SAFE_INTEGER, limit: 2 },
])("read preview headings request the subject's lines: %j", (range) => {
  const args = { path: "/project/src/a.ts", ...range };
  const subject = summary("read", args)?.subject ?? "";
  const call = readPreviewRenderers("/project").renderCall(args, theme, renderContextFixture());
  const heading = renderComponent(call);
  expect(heading).toContain(subject);
  // No further range follows the subject's own.
  for (const next of [":", "-"]) expect(heading).not.toContain(subject + next);
});

test.each([{ offset: "5" }, { offset: null }])(
  "read headings and subjects show no range for a non-numeric offset: %j",
  (range) => {
    const args = { path: "/project/src/a.ts", ...range };
    const call = readPreviewRenderers("/project").renderCall(args, theme, renderContextFixture());
    const heading = renderComponent(call);
    expect(heading).toContain("a.ts");
    expect(heading).not.toContain("a.ts:");
    // Pi coerces the offset before reading, so `:1` would name the wrong line. Replayed
    // arguments may carry an offset outside the declared input type.
    const replayed: Args = { path: args.path };
    Object.assign(replayed, range);
    expect(summary("read", replayed)?.subject).toBe("src/a.ts");
  },
);

test("write replay needs actual submitted content before describing changes", () => {
  const details = { codePreviewBeforeWrite: { kind: "content", content: "keep\n" } };
  for (const content of [undefined, null, 42]) {
    // Replayed write arguments may carry content outside the declared input type.
    const args: Args = { path: "x" };
    Object.assign(args, { content });
    const replay = result("applied", details);
    expect(summary("write", args, replay, "settled", { argsComplete: false })).toBeUndefined();
  }
  expect(
    summary("write", { path: "x", content: "" }, result("applied", details))?.counters,
  ).toEqual(["+0 −1"]);
});

describe("builtin compact lifecycle", () => {
  test.each(tools)(
    "%s does not mistake pending arguments or running output for success",
    (tool) => {
      const args = { path: "file.ts", command: "printf done", pattern: "value" };
      const pending = summary(tool, args);
      const running = summary(tool, args, result("ordinary output"), "running");
      expect(pending).toBeDefined();
      expect(running).toBeDefined();
      expect(pending?.outcome).toBeUndefined();
      expect(running?.outcome).toBeUndefined();
      expect(JSON.stringify(running)).not.toContain("ordinary output");
      expect(summary(tool, args, undefined, "settled")).toBeUndefined();
    },
  );

  test.each(tools)("%s accepts recorded success without live execution flags", (tool) => {
    const details =
      tool === "write"
        ? { codePreviewBeforeWrite: { kind: "content", content: "old" } }
        : tool === "edit"
          ? { diff: "-1 old\n+1 new" }
          : undefined;
    const value = summary(
      tool,
      { path: "file.ts", command: "true", content: "new" },
      result("done", details),
      "settled",
      {
        argsComplete: false,
        executionStarted: false,
      },
    );
    expect(value?.outcome).toBe("success");
    expect(value?.issues).toEqual([]);
    expect(value?.subject).toContain(tool === "bash" ? "true" : "file.ts");
  });

  test.each(tools)("%s reports host errors with the settings-driven projection", (tool) => {
    const value = summary(tool, { path: "file.ts" }, result("Failed.\nRetry later."), "settled", {
      isError: true,
      argsComplete: false,
      executionStarted: false,
    });
    expect(value?.outcome).toBe("error");
    expect(value?.issues?.[0]).toMatchObject({ severity: "error", message: "Failed" });
    expect(JSON.stringify(value)).not.toMatch(/Retry later|applied|new file/iu);
    expect(summary(tool, {}, result("Operation aborted"), "settled", { isError: true })).toEqual(
      expect.objectContaining({ outcome: "cancelled", issues: [] }),
    );
  });
});

describe("issues independent of hidden preview bodies", () => {
  test("bash command warnings survive every phase", () => {
    for (const phase of ["pending", "running", "settled"] as const) {
      const value = summary(
        "bash",
        { command: "rm -rf build" },
        phase === "pending" ? undefined : result("ordinary output"),
        phase,
      );
      expect(value?.issues).toEqual([
        expect.objectContaining({ severity: "warning", message: "Deletes files recursively" }),
      ]);
      expect(value?.outcome).toBe(phase === "settled" ? "warning" : undefined);
    }
  });

  test.each(tools)("%s detects secrets in hidden result output", (tool) => {
    const value = summary(tool, {}, result(secret), "running");
    expect(codes(value)).toEqual(["possible-secrets"]);
    expect(issueFor(value, "possible-secrets")?.message).toContain("private key");
  });

  test("pending writes and edits scan inputs without calculating diffs", () => {
    for (const [tool, args] of [
      ["write", { path: "file", content: secret }],
      ["edit", { path: "file", edits: [{ oldText: secret, newText: "removed" }] }],
      ["edit", { path: "file", old_text: "before", new_text: secret }],
    ] satisfies Array<[BuiltinCompactTool, Args]>) {
      const value = summary(tool, args);
      expect(codes(value)).toEqual(["possible-secrets"]);
      expect(value?.counters ?? []).toEqual([]);
    }
  });

  test("secret scanning keeps the bounded tail sample of large input", () => {
    const content = "x".repeat(codePreviewPerformanceConfig.secretScanChars * 2) + "\n" + secret;
    expect(codes(summary("write", { content }))).toContain("possible-secrets");
  });

  test("the smallest secret scan budget cannot expand into a whole-input scan", () => {
    setCodePreviewPerformanceConfig({ ...codePreviewPerformanceConfig, secretScanChars: 1 });
    expect(codes(summary("write", { content: "x".repeat(1000) + secret }))).toEqual([]);
  });

  test("warning toggles suppress detection, not mandatory limitations", () => {
    setCodePreviewSettings({ ...codePreviewSettings, secretWarnings: false, bashWarnings: false });
    const value = summary(
      "bash",
      { command: "rm -rf build" },
      result(secret, { truncation: { truncated: true } }),
    );
    expect(codes(value)).toEqual(["output-truncated"]);
    expect(value?.outcome).toBe("warning");
  });

  test("read reports complete-line pagination as information, including byte caps", () => {
    for (const page of [
      {
        args: { path: "file", limit: 5 },
        output: result("slice\n\n[73 more lines in file. Use offset=6 to continue.]"),
        next: "Use offset=6 to continue.",
      },
      {
        args: { path: "file" },
        output: result("slice\n\n[Showing lines 1-2000 of 4000. Use offset=2001 to continue.]", {
          truncation: { truncated: true, truncatedBy: "lines" },
        }),
        next: "Use offset=2001 to continue.",
      },
      {
        args: { path: "file" },
        output: result(
          "slice\n\n[Showing lines 1-142 of 180 (50.0KB limit). Use offset=143 to continue.]",
          {
            truncation: { truncated: true, truncatedBy: "bytes", lastLinePartial: false },
          },
        ),
        next: "Use offset=143 to continue.",
      },
    ]) {
      const value = summary("read", page.args, page.output);
      expect(value?.outcome).toBe("success");
      expect(value?.issues).toEqual([
        expect.objectContaining({ severity: "info", code: "read-continuation", detail: page.next }),
      ]);
      // The collapsed message states the page; the agent procedure is expanded detail only.
      expect(value?.issues?.[0]?.message).not.toContain("offset=");
      const sensitive = summary("read", page.args, {
        ...page.output,
        content: [{ type: "text", text: secret }, ...page.output.content],
      });
      expect(sensitive?.outcome).toBe("warning");
      expect(codes(sensitive)).toEqual(["possible-secrets", "read-continuation"]);
    }
  });

  test("read does not hide partial lines or unrecognized byte-limit annotations", () => {
    for (const truncatedBy of ["bytes", "lines"]) {
      for (const lastLinePartial of [true, false, undefined]) {
        for (const suffix of ["", " (50.0KB limit)", " (inspect missing content)"]) {
          const value = summary(
            "read",
            { path: "file" },
            result(`slice\n\n[Showing lines 1-2 of 10${suffix}. Use offset=3 to continue.]`, {
              truncation: { truncated: true, truncatedBy, lastLinePartial },
            }),
          );
          const routine =
            (truncatedBy === "lines" && !suffix && lastLinePartial !== true) ||
            (truncatedBy === "bytes" && suffix === " (50.0KB limit)" && lastLinePartial === false);
          expect(value?.outcome).toBe(routine ? "success" : "warning");
          expect(codes(value)).toEqual([routine ? "read-continuation" : "read-truncated"]);
          expect(value?.issues?.[0]?.detail).toContain("offset=3");
        }
      }
    }
  });

  test("read preserves truncated continuation and oversized-line bash recovery", () => {
    for (const args of [{ path: "file" }, { path: "file", limit: 5 }]) {
      for (const truncation of [
        { truncated: true, truncatedBy: "bytes" },
        { truncated: true, truncatedBy: "lines" },
        { truncated: true },
      ]) {
        const value = summary(
          "read",
          args,
          result("line\n\n[Showing lines 1-1 of 9 (50KB limit). Use offset=2 to continue.]", {
            truncation,
          }),
        );
        expect(value?.outcome).toBe("warning");
        expect(issueFor(value, "read-truncated")?.detail).toContain("offset=2");
      }
      const unknown = summary(
        "read",
        args,
        result("line\n\n[Showing lines 1-1 of 9. Use offset=2 to continue.]", {
          truncation: { truncated: true },
        }),
      );
      expect(unknown?.outcome).toBe("warning");
      expect(issueFor(unknown, "read-truncated")?.detail).toContain("offset=2");
    }
    const recovery = "[Line 1 exceeds the read limit. Use bash: head -c 51200 file]";
    const oversized = summary(
      "read",
      {},
      result(recovery, { truncation: { truncated: true, firstLineExceedsLimit: true } }),
    );
    expect(oversized?.outcome).toBe("warning");
    expect(oversized?.issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "oversized-first-line",
        detail: recovery,
      }),
    ]);
    // An unrecognized continuation is still reported as truncation; its text stays expanded.
    const unknown = summary(
      "read",
      {},
      result("Unknown continuation instructions", { truncation: { truncated: true } }),
    );
    expect(unknown?.outcome).toBe("warning");
    expect(unknown?.issues).toEqual([
      expect.objectContaining({ severity: "warning", code: "read-truncated" }),
    ]);
    expect(JSON.stringify(unknown)).not.toContain("Unknown continuation");
  });

  test.each([
    ["grep", "matchLimitReached"],
    ["find", "resultLimitReached"],
    ["ls", "entryLimitReached"],
  ] as const)("%s treats a reached cap as a counter, not a total or issue", (tool, field) => {
    const output = result("one result", { [field]: 10 });
    const before = structuredClone(output);
    const value = summary(tool, {}, output);
    expect(value?.outcome).toBe("success");
    expect(value?.issues).toEqual([]);
    expect(value?.counters).toEqual(["limit reached: 10"]);
    expect(value?.metadata).toEqual([]);
    expect(output).toEqual(before);
    const sensitive = summary(tool, {}, result(secret, output.details));
    expect(sensitive?.outcome).toBe("warning");
    expect(codes(sensitive)).toEqual(["possible-secrets"]);
    expect(sensitive?.counters).toEqual(value?.counters);
    const failed = summary(tool, {}, output, "settled", { isError: true });
    expect(failed?.outcome).toBe("error");
    expect(failed?.issues?.[0]).toMatchObject({ severity: "error", message: "one result" });
  });

  const byteCap = { truncation: { truncated: true } };
  test.each([
    ["grep", { matchLimitReached: 10, linesTruncated: true }, ["grep-partial-lines"]],
    [
      "grep",
      { matchLimitReached: 10, linesTruncated: true, ...byteCap },
      ["output-truncated", "grep-partial-lines"],
    ],
    ["find", { resultLimitReached: 10, ...byteCap }, ["output-truncated"]],
    ["ls", { entryLimitReached: 10, ...byteCap }, ["output-truncated"]],
  ] as const)("%s keeps line or byte loss warnings beside caps", (tool, details, expected) => {
    const value = summary(tool, { path: ".", pattern: "value" }, result("match", details));
    expect(value?.outcome).toBe("warning");
    expect(value?.counters).toEqual(["limit reached: 10"]);
    expect(value?.metadata).toEqual([]);
    expect(codes(value)).toEqual(expected);
    expect(value?.issues?.every((entry) => entry.severity === "warning")).toBe(true);
  });
});

describe("write and edit diff limitations", () => {
  test("live new-file evidence differs from absent or redacted replay snapshots", () => {
    const args = { path: "file", content: "next" };
    const live = summary("write", args, result("applied", { codePreviewBeforeWrite: undefined }));
    expect(live?.outcome).toBe("success");
    expect(live?.issues).toEqual([]);
    expect(live?.counters).toEqual(["new file"]);
    for (const details of [
      undefined,
      {},
      { codePreviewBeforeWrite: { kind: "content", byteLength: 4 } },
    ]) {
      const replay = summary("write", args, result("applied", details));
      // Unavailable history limits the preview, not the write.
      expect(replay?.outcome).toBe("success");
      expect(codes(replay)).toEqual(["write-history-unavailable"]);
      expect(JSON.stringify(replay)).not.toMatch(/new file/i);
    }
  });

  test("write detects byte and complexity guards without producing a diff", () => {
    const huge = "x".repeat(codePreviewPerformanceConfig.maxWriteDiffBytes);
    const bytes = summary(
      "write",
      { content: "new" },
      result("applied", { codePreviewBeforeWrite: { kind: "content", content: huge } }),
    );
    expect(bytes?.issues).toEqual([]);
    expect(bytes?.metadata).toEqual(["diff skipped: size"]);
    expect(bytes?.outcome).toBe("success");
    const lineCount =
      Math.ceil(Math.sqrt(codePreviewPerformanceConfig.maxWriteDiffChangedLineCells)) + 1;
    const complex = summary(
      "write",
      { content: "new\n".repeat(lineCount) },
      result("applied", {
        codePreviewBeforeWrite: { kind: "content", content: "old\n".repeat(lineCount) },
      }),
    );
    expect(complex?.issues).toEqual([]);
    expect(complex?.metadata).toEqual(["diff skipped: complexity"]);
    expect(complex?.outcome).toBe("success");
  });

  test("write never infers size skips from prose or hides unavailable history behind large input", () => {
    for (const before of [
      undefined,
      { kind: "skipped", reason: "previous content unavailable", maxBytes: 10 },
      {
        kind: "skipped",
        reason: "previous path is not a regular file",
        maxBytes: 10,
        byteLength: 20,
      },
      { kind: "skipped", reason: "previous file too large", maxBytes: 10 },
      { kind: "skipped", reason: "unknown guard", maxBytes: 10 },
      { kind: "skipped", reason: 42, maxBytes: 10, byteLength: 20, sizeExceeded: true },
      { kind: "skipped", reason: " ", maxBytes: 10, byteLength: 20, sizeExceeded: true },
      {
        kind: "skipped",
        reason: "bad size evidence",
        maxBytes: 10,
        byteLength: 2,
        sizeExceeded: true,
      },
    ]) {
      for (const content of [
        "new",
        "x".repeat(codePreviewPerformanceConfig.maxWriteDiffBytes + 1),
      ]) {
        const output = result(
          "applied",
          before === undefined ? {} : { codePreviewBeforeWrite: before },
        );
        const value = summary("write", { content }, output);
        expect(value?.outcome).toBe("success");
        expect(value?.issues?.length).toBeGreaterThan(0);
        expect(value?.issues?.every((entry) => entry.severity === "info")).toBe(true);
        expect(value?.metadata).toEqual([]);
      }
    }
  });

  test("write size skips stay quiet without suppressing secrets or execution failures", () => {
    const output = result("applied", {
      codePreviewBeforeWrite: {
        kind: "skipped",
        reason: "size guard",
        maxBytes: 10,
        byteLength: 20,
        sizeExceeded: true,
      },
    });
    const quiet = summary("write", { path: "file", content: "next" }, output);
    expect(quiet?.issues).toEqual([]);
    expect(quiet?.metadata).toEqual(["diff skipped: size"]);
    expect(quiet?.outcome).toBe("success");
    const value = summary("write", { content: secret }, output);
    expect(value?.outcome).toBe("warning");
    expect(value?.metadata).toEqual(["diff skipped: size"]);
    expect(codes(value)).toEqual(["possible-secrets"]);
    const failed = summary("write", {}, output, "settled", { isError: true });
    expect(failed?.outcome).toBe("error");
    expect(failed?.metadata ?? []).toEqual([]);
  });
});

/** Renders both slots from one context so toggles share the retained shell state. */
function renderText(
  tool: ToolRenderers,
  output: AgentToolResult<unknown>,
  ctx: ToolRenderContext<object, unknown>,
  width = 100,
): string {
  const call = tool.renderCall?.(ctx.args, theme, ctx);
  const body = tool.renderResult?.(
    output,
    { expanded: ctx.expanded, isPartial: false },
    theme,
    ctx,
  );
  return [call, body].flatMap((part) => part?.render(width) ?? []).join("\n");
}

const builtin = (name: BuiltinCompactTool) => builtinRenderers(name)!;

describe("builtin factory compact integration", () => {
  const args = {
    path: "file.ts",
    command: "printf value",
    pattern: "value",
    content: "proposedContent",
    edits: [{ oldText: "before", newText: "proposedContent" }],
  };
  const context = (
    overrides: Partial<ToolRenderContext<object, typeof args>> = {},
  ): ToolRenderContext<object, typeof args> =>
    renderContextFixture({
      args,
      toolCallId: "builtin-render-test",
      isPartial: false,
      ...overrides,
    });

  test.each(["grep", "find", "ls"] as const)(
    "%s keeps complete limit instructions in unchanged expanded results",
    (name) => {
      const tool = builtin(name);
      const ctx = context();
      const output = result("selectedContent\n\n[Limit reached. Use limit=20 to continue.]", {
        matchLimitReached: 10,
        resultLimitReached: 10,
        entryLimitReached: 10,
      });
      const before = structuredClone(output);
      for (const expanded of [false, true, false, true]) {
        const text = renderText(tool, output, { ...ctx, expanded });
        expect(text.includes("limit=20")).toBe(expanded);
        expect(text.includes("selectedContent")).toBe(expanded);
      }
      expect(output).toEqual(before);
    },
  );

  test("write expansion distinguishes observed new files from unavailable history", () => {
    const fresh = { codePreviewBeforeWrite: undefined };
    const accessor = Object.defineProperty({}, "codePreviewBeforeWrite", { get: () => undefined });
    for (const details of [
      undefined,
      {},
      fresh,
      JSON.parse(JSON.stringify(fresh)),
      accessor,
      { codePreviewBeforeWrite: { kind: "content", byteLength: 12 } },
      { codePreviewBeforeWrite: { kind: "unrecognized" } },
    ]) {
      const tool = builtin("write");
      const ctx = context();
      const output = result<undefined>("applied");
      Object.assign(output, { details });
      const knownNew = details === fresh;
      for (const expanded of [false, true, false, true]) {
        const text = renderText(tool, output, { ...ctx, expanded }, 200);
        expect(/new file/iu.test(text)).toBe(knownNew);
        // Informational: explained on expansion only.
        expect(/previous contents unknown/u.test(text)).toBe(!knownNew && expanded);
      }
    }
  });

  test("quiet write size guards preserve the original expanded skip reason and result", () => {
    const tool = builtin("write");
    const ctx = context();
    const output = result<undefined>("applied");
    Object.assign(output, {
      details: {
        codePreviewBeforeWrite: {
          kind: "skipped",
          reason: "previous file too large",
          maxBytes: 10,
          byteLength: 20,
          sizeExceeded: true,
        },
      },
    });
    const before = structuredClone(output);
    for (const expanded of [false, true, false, true]) {
      const text = renderText(tool, output, { ...ctx, expanded });
      expect(text.includes("previous file too large")).toBe(expanded);
    }
    expect(output).toEqual(before);
  });

  test.each([false, true])(
    "routine read pagination stays expanded-only, byte cap: %s",
    (byteCap) => {
      for (const mode of ["on", "off", "border"] as const) {
        setCodePreviewSettings({ ...codePreviewSettings, toolCallBackground: mode });
        const tool = builtin("read");
        const readArgs = { ...args, limit: 5 };
        const ctx = context({ args: readArgs });
        const output = byteCap
          ? result(
              "selectedContent\n\n[Showing lines 1-142 of 180 (50.0KB limit). Use offset=143 to continue.]",
              {
                truncation: {
                  content: "selectedContent",
                  truncated: true,
                  truncatedBy: "bytes" as const,
                  lastLinePartial: false,
                  firstLineExceedsLimit: false,
                  totalLines: 180,
                  totalBytes: 60000,
                  outputLines: 142,
                  outputBytes: 51000,
                  maxLines: 2000,
                  maxBytes: 51200,
                },
              },
            )
          : result<undefined>(
              "selectedContent\n\n[73 more lines in file. Use offset=6 to continue.]",
            );
        const before = structuredClone(output);
        const page = summary("read", readArgs, output)?.issues?.[0]?.message;
        expect(page).toBeTruthy();
        for (const expanded of [false, true, false, true]) {
          const text = renderText(tool, output, { ...ctx, expanded });
          expect(text.includes(page!)).toBe(expanded);
          expect(text.includes("offset=")).toBe(expanded);
          expect(text.includes("selectedContent")).toBe(expanded);
        }
        expect(output).toEqual(before);
      }
    },
  );

  test.each(["on", "off", "border"] as const)(
    "recognized edit failure and nonroutine read recovery render their issue once in %s mode",
    (mode) => {
      setCodePreviewSettings({ ...codePreviewSettings, toolCallBackground: mode });
      const edit = builtin("edit");
      const editOutput = result<undefined>(
        "No changes made to /project/file.ts. The replacements produced identical content.",
      );
      const refusal = summary("edit", args, editOutput, "settled", { isError: true })?.issues?.[0];
      expect(refusal?.code).toBe("edit-unchanged");
      for (const expanded of [false, true, false, true]) {
        const ctx = { ...context({ isError: true, expanded }), state: {} };
        const text = renderText(edit, editOutput, ctx);
        expect(text.split(refusal!.message)).toHaveLength(2);
        // The raw host error is kept once, in the expanded result.
        expect(text.split("The replacements produced identical content.")).toHaveLength(
          expanded ? 2 : 1,
        );
        // Unique call source survives a failed edit.
        expect(text.includes("proposedContent")).toBe(expanded);
      }
      const read = builtin("read");
      const truncation = {
        content: "slice",
        truncated: true,
        truncatedBy: "bytes" as const,
        totalLines: 10,
        totalBytes: 100_000,
        outputLines: 2,
        outputBytes: 5,
        lastLinePartial: true,
        firstLineExceedsLimit: false,
        maxLines: 2_000,
        maxBytes: 51_200,
      };
      for (const sample of [
        {
          output: result(
            "slice\n\n[Showing lines 1-2 of 10 (50KB limit). Use offset=3 to continue.]",
            { truncation },
          ),
          phrase: "offset=3",
        },
        {
          output: result("[Line 1 exceeds the read limit. Use bash: head -c 51200 file]", {
            truncation: { ...truncation, firstLineExceedsLimit: true },
          }),
          phrase: "head -c 51200",
        },
      ]) {
        const before = structuredClone(sample.output);
        const warning = summary("read", args, sample.output)?.issues?.[0];
        expect(warning?.severity).toBe("warning");
        for (const expanded of [false, true, false, true]) {
          const text = renderText(read, sample.output, context({ expanded }));
          expect(text.split(warning!.message)).toHaveLength(2);
          expect(text.includes(sample.phrase)).toBe(expanded);
        }
        expect(sample.output).toEqual(before);
      }
    },
  );

  test.each(tools)(
    "%s keeps declined failure projections compact without losing expanded recovery",
    (name) => {
      for (const mode of ["on", "off", "border"] as const) {
        setCodePreviewSettings({ ...codePreviewSettings, toolCallBackground: mode });
        const tool = builtin(name);
        const ctx = context({ isError: true });
        const output = {
          content: [
            { type: "text" as const, text: "Diagnostic starts\n" + "x".repeat(128 * 1024 + 1) },
            { type: "text" as const, text: "Inspect destination before retrying." },
            { type: "image" as const, mimeType: "image/png", data: "" },
          ],
          details: undefined,
        };
        const before = structuredClone(output);
        expect(summary(name, args, output, "settled", { isError: true })).toBeUndefined();
        for (const expanded of [false, true, false]) {
          const text = renderText(tool, output, { ...ctx, expanded }, 200);
          // Without a projection the collapsed row explains the error by its first line.
          expect(text.includes("Diagnostic starts")).toBe(true);
          expect(text.includes("Inspect destination before retrying.")).toBe(expanded);
          expect(text.includes("x".repeat(100))).toBe(expanded);
        }
        expect(output).toEqual(before);
      }
    },
  );

  test.each(["write", "edit"] as const)("%s hides pending content until expanded", (name) => {
    const tool = builtin(name);
    const ctx = context();
    const collapsed = tool.renderCall?.(args, theme, ctx);
    expect(collapsed && renderComponent(collapsed)).not.toContain("proposedContent");
    const expanded = tool.renderCall?.(args, theme, { ...ctx, expanded: true });
    expect(expanded && renderComponent(expanded)).toContain("proposedContent");
  });
});

test("over-budget parsing declines compaction rather than clipping error text", () => {
  const output = "x".repeat(128 * 1024 + 1);
  expect(summary("bash", {}, result(output), "settled", { isError: true })).toBeUndefined();
  expect(summary("read", {}, result(output))).toBeUndefined();
  // An unscanned long command is flagged rather than implied safe.
  expect(summary("bash", { command: "x".repeat(16 * 1024 + 1) })?.issues).toEqual([
    expect.objectContaining({ severity: "warning", code: "command-unchecked" }),
  ]);
  expect(
    summary("edit", { edits: Array.from({ length: 65 }, () => ({ oldText: "a", newText: "b" })) }),
  ).toBeUndefined();
});
