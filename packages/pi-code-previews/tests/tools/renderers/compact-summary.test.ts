import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type {
  AgentToolResult,
  ReadToolInput,
  BashToolInput,
  WriteToolInput,
  EditToolInput,
  GrepToolInput,
} from "@earendil-works/pi-coding-agent";
import { defaultCodePreviewSettings } from "../../../src/config/defaults";
import {
  codePreviewPerformanceConfig,
  codePreviewToolsEnvironmentValue,
  publishCodePreviewEnvironmentProjection,
} from "../../../src/config/env";
import { codePreviewSettings, setCodePreviewSettings } from "../../../src/config/state";
import {
  createBuiltinCompactSummary,
  type BuiltinCompactTool,
} from "../../../src/tools/builtin-compact-summary";
import type { CompactPhase, CompactSummary } from "../../../src/tools/compact-summary";
import type { ToolRenderContext } from "../../../src/tools/renderers/shared/types";
import { createReadPreviewTool } from "../../../src/tools/renderers/read";
import { createBashPreviewTool } from "../../../src/tools/renderers/bash";
import { createGrepPreviewTool } from "../../../src/tools/renderers/grep";
import { createFindPreviewTool } from "../../../src/tools/renderers/find";
import { createLsPreviewTool } from "../../../src/tools/renderers/ls";
import { createWritePreviewTool } from "../../../src/tools/renderers/write";
import { createEditPreviewTool } from "../../../src/tools/renderers/edit";
import { renderComponent, testTheme } from "../../support/render";

const originalSettings = { ...codePreviewSettings, tools: [...codePreviewSettings.tools] };
const originalPerformance = codePreviewPerformanceConfig;
const originalToolsEnvironment = codePreviewToolsEnvironmentValue;
const secret = "-----BEGIN PRIVATE KEY-----";
type Args = Partial<
  ReadToolInput & BashToolInput & WriteToolInput & EditToolInput & GrepToolInput
> & {
  old_text?: string;
  new_text?: string;
};
type FactoryState = Parameters<
  NonNullable<ReturnType<typeof createBashPreviewTool>["renderCall"]>
>[2]["state"];

beforeEach(() =>
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    toolCallCollapsedStyle: "compact",
    toolCallBackground: "off",
    toolCallTiming: false,
    readContentPreview: false,
    writeContentPreview: false,
    editDiffPreview: false,
    grepResultPreview: false,
    findResultPreview: false,
    lsResultPreview: false,
    bashWarnings: true,
    secretWarnings: true,
  }),
);
afterEach(() => {
  setCodePreviewSettings(originalSettings);
  publishCodePreviewEnvironmentProjection(originalPerformance, originalToolsEnvironment);
});

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
    context: {
      args,
      state: {},
      toolCallId: "compact-summary-test",
      cwd: "/project",
      invalidate: () => undefined,
      lastComponent: undefined,
      argsComplete: phase !== "pending",
      executionStarted: phase === "running",
      expanded: false,
      isPartial: phase === "running",
      isError: false,
      showImages: true,
      ...overrides,
    },
  });
}

function result<Details>(
  text = "ordinary output",
  details?: Details,
): AgentToolResult<Details | undefined> {
  return { content: [{ type: "text", text }], details };
}

function noticeText(value: CompactSummary | undefined): string {
  expect(value).toBeDefined();
  return value?.notices?.map((notice) => notice.text).join("\n") ?? "";
}

const tools: BuiltinCompactTool[] = ["read", "bash", "write", "edit", "grep", "find", "ls"];

describe("builtin compact lifecycle", () => {
  test.each(tools)(
    "%s does not mistake pending arguments or running output for success",
    (tool) => {
      const args = { path: "file.ts", command: "printf done", pattern: "value" };
      const pending = summary(tool, args);
      const running = summary(tool, args, result(), "running");
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
    expect(value?.subject).toContain(tool === "bash" ? "true" : "file.ts");
  });

  test.each(tools)("%s preserves complete failure and recovery text", (tool) => {
    const failure = "Operation aborted\nInspect the file before retrying.";
    const value = summary(tool, { path: "file.ts" }, result(failure), "settled", {
      isError: true,
      argsComplete: false,
      executionStarted: false,
    });
    expect(value?.outcome).toBe("error");
    expect(value?.failure?.details).toBe(failure);
    expect(value?.failure?.cause).toContain("Inspect the file before retrying.");
    expect(value?.notices).not.toContainEqual({ kind: "error", text: failure });
    expect(noticeText(value)).not.toMatch(/applied|new file/i);
  });

  test.each(tools)("%s distinguishes explicit cancellation from failure", (tool) => {
    const value = summary(tool, {}, result("Operation aborted"), "settled", { isError: true });
    expect(value?.outcome).toBe("cancelled");
    expect(value?.failure?.details).toBe("Operation aborted");
  });

  test("known filesystem errors shorten the cause without losing continuation instructions", () => {
    const output =
      "ENOENT: no such file or directory, access '/project/file.ts'\nInspect parent permissions before retrying.";
    const value = summary("read", { path: "file.ts" }, result(output), "settled", {
      isError: true,
    });
    expect(value?.failure?.cause).toContain("ENOENT");
    expect(value?.failure?.cause).not.toContain("/project/file.ts");
    expect(value?.failure?.details).toBe(output);
    expect(noticeText(value)).toContain("Inspect parent permissions before retrying.");
  });

  test("bash hides ordinary diagnostics but keeps terminal status and text-only recovery", () => {
    const footer = "[Showing lines 10-20 of 20. Full output: /tmp/failure-log.txt]";
    const output = `ordinaryDiagnostic\n\n${footer}\n\nCommand exited with code 7`;
    const value = summary("bash", { command: "false" }, result(output, {}), "settled", {
      isError: true,
    });
    expect(value?.outcome).toBe("error");
    expect(value?.failure?.cause).toContain("7");
    expect(value?.failure?.cause).not.toContain("ordinaryDiagnostic");
    expect(value?.failure?.details).toBe(output);
    expect(noticeText(value)).toContain(footer);
    expect(
      summary("bash", {}, result("Command exited with code 7\nunknown tail"), "settled", {
        isError: true,
      })?.failure?.cause,
    ).toContain("unknown tail");
    expect(
      summary("bash", {}, result("stdout\n\nCommand aborted"), "settled", { isError: true })
        ?.outcome,
    ).toBe("cancelled");
  });

  test("empty errors remain failures and attachment results retain the original renderer", () => {
    const empty = summary("read", {}, result(""), "settled", { isError: true });
    expect(empty?.outcome).toBe("error");
    expect(empty?.failure?.cause).toBeTruthy();
    expect(
      summary(
        "read",
        {},
        { content: [{ type: "image", mimeType: "image/png", data: "AAAA" }], details: undefined },
        "settled",
        { isError: true },
      ),
    ).toBeUndefined();
  });

  test("read subject includes the requested line range", () => {
    expect(summary("read", { path: "file.ts", offset: 7, limit: 3 })?.subject).toContain(
      "file.ts:7-9",
    );
  });
});

describe("notices independent of hidden preview bodies", () => {
  test("bash command warnings survive every phase and retain full-output recovery on errors", () => {
    for (const phase of ["pending", "running", "settled"] as const) {
      const value = summary(
        "bash",
        { command: "rm -rf build" },
        phase === "pending" ? undefined : result(),
        phase,
      );
      expect(noticeText(value)).toContain("recursive delete");
    }
    const value = summary(
      "bash",
      { command: "false" },
      result("failed", {
        truncation: { truncated: true },
        fullOutputPath: "/tmp/bash-full.txt",
      }),
      "settled",
      { isError: true },
    );
    expect(value?.outcome).toBe("error");
    expect(noticeText(value)).toContain("truncated");
    expect(noticeText(value)).toContain("/tmp/bash-full.txt");
  });

  test.each(tools)("%s detects secrets in hidden result output", (tool) => {
    expect(noticeText(summary(tool, {}, result(secret), "running"))).toContain("private key");
  });

  test("pending writes and edits scan inputs without calculating diffs", () => {
    expect(noticeText(summary("write", { path: "file", content: secret }))).toContain(
      "private key",
    );
    expect(
      noticeText(
        summary("edit", { path: "file", edits: [{ oldText: secret, newText: "removed" }] }),
      ),
    ).toContain("private key");
    expect(
      noticeText(summary("edit", { path: "file", old_text: "before", new_text: secret })),
    ).toContain("private key");
  });

  test("secret scanning keeps the bounded tail sample of large input", () => {
    const content = "x".repeat(codePreviewPerformanceConfig.secretScanChars * 2) + "\n" + secret;
    expect(noticeText(summary("write", { content }))).toContain("private key");
  });

  test("the smallest secret scan budget cannot expand into a whole-input scan", () => {
    publishCodePreviewEnvironmentProjection(
      { ...codePreviewPerformanceConfig, secretScanChars: 1 },
      originalToolsEnvironment,
    );
    const value = summary("write", { content: "x".repeat(1000) + secret });
    expect(noticeText(value)).not.toContain("private key");
  });

  test("warning toggles suppress detection, not mandatory limitations", () => {
    setCodePreviewSettings({ ...codePreviewSettings, secretWarnings: false, bashWarnings: false });
    const value = summary(
      "bash",
      { command: "rm -rf build" },
      result(secret, { truncation: { truncated: true } }),
    );
    const notices = noticeText(value);
    expect(notices).not.toContain("private key");
    expect(notices).not.toContain("recursive delete");
    expect(notices).toContain("truncated");
    expect(value?.outcome).toBe("warning");
  });

  test("read treats requested ranges and known line pagination as ordinary retrieval", () => {
    for (const page of [
      {
        args: { path: "file", limit: 5 },
        output: result("slice\n\n[73 more lines in file. Use offset=6 to continue.]"),
      },
      {
        args: { path: "file" },
        output: result("slice\n\n[Showing lines 1-2000 of 4000. Use offset=2001 to continue.]", {
          truncation: { truncated: true, truncatedBy: "lines" },
        }),
      },
    ]) {
      const value = summary("read", page.args, page.output);
      expect(value?.outcome).toBe("success");
      expect(value?.notices).toEqual([]);
      const sensitive = summary("read", page.args, {
        ...page.output,
        content: [{ type: "text", text: secret }, ...page.output.content],
      });
      expect(sensitive?.outcome).toBe("warning");
      expect(noticeText(sensitive)).toContain("private key");
      expect(noticeText(sensitive)).not.toContain("offset=");
    }
  });

  test("read preserves truncated continuation and oversized-line bash recovery", () => {
    for (const args of [{ path: "file" }, { path: "file", limit: 5 }]) {
      for (const truncatedBy of ["bytes", "lines", undefined]) {
        const value = summary(
          "read",
          args,
          result("line\n\n[Showing lines 1-1 of 9 (50KB limit). Use offset=2 to continue.]", {
            truncation: { truncated: true, truncatedBy },
          }),
        );
        expect(value?.outcome).toBe("warning");
        expect(noticeText(value)).toContain("offset=2");
      }
      const unknown = summary(
        "read",
        args,
        result("line\n\n[Showing lines 1-1 of 9. Use offset=2 to continue.]", {
          truncation: { truncated: true },
        }),
      );
      expect(unknown?.outcome).toBe("warning");
      expect(noticeText(unknown)).toContain("offset=2");
    }
    const recovery = "[Line 1 exceeds the read limit. Use bash: head -c 51200 file]";
    const oversized = summary(
      "read",
      {},
      result(recovery, { truncation: { truncated: true, firstLineExceedsLimit: true } }),
    );
    expect(oversized?.outcome).toBe("warning");
    expect(oversized?.notices).toContainEqual({ kind: "recovery", text: recovery });
    expect(
      summary(
        "read",
        {},
        result("Unknown continuation instructions", { truncation: { truncated: true } }),
      ),
    ).toBeUndefined();
  });

  test("grep retains match, byte, and line limits with recovery guidance", () => {
    const value = summary(
      "grep",
      { pattern: "value" },
      result("match", {
        matchLimitReached: 10,
        linesTruncated: true,
        truncation: { truncated: true },
      }),
    );
    expect(noticeText(value)).toContain("limit=20");
    expect(noticeText(value)).toContain("read tool");
    expect(noticeText(value)).toContain("truncated");
    expect(value?.outcome).toBe("warning");
  });

  test.each(["find", "ls"] as const)("%s retains result limits and byte truncation", (tool) => {
    const value = summary(
      tool,
      { path: ".", pattern: "*.ts" },
      result("file.ts", {
        [tool === "find" ? "resultLimitReached" : "entryLimitReached"]: 10,
        truncation: { truncated: true },
      }),
    );
    expect(noticeText(value)).toContain("limit=20");
    expect(noticeText(value)).toContain("truncated");
    expect(value?.outcome).toBe("warning");
  });
});

describe("write and edit diff limitations", () => {
  test("live new-file evidence differs from absent or redacted replay snapshots", () => {
    const args = { path: "file", content: "next" };
    const live = summary("write", args, result("applied", { codePreviewBeforeWrite: undefined }));
    expect(live?.outcome).toBe("success");
    expect(live?.notices).toHaveLength(0);
    for (const details of [
      undefined,
      {},
      { codePreviewBeforeWrite: { kind: "content", byteLength: 4 } },
    ]) {
      const replay = summary("write", args, result("applied", details));
      expect(replay?.outcome).toBe("warning");
      expect(noticeText(replay)).toContain("unavailable");
      expect(JSON.stringify(replay)).not.toMatch(/new file/i);
    }
  });

  test("write preserves skipped snapshot reasons with previews disabled", () => {
    const value = summary(
      "write",
      { path: "file", content: "next" },
      result("applied", {
        codePreviewBeforeWrite: {
          kind: "skipped",
          reason: "previous file too large",
          maxBytes: 10,
          byteLength: 20,
          sizeExceeded: true,
        },
      }),
    );
    expect(noticeText(value)).toContain("previous file too large");
    expect(value?.outcome).toBe("warning");
  });

  test("write detects byte and complexity guards without producing a diff", () => {
    const huge = "x".repeat(codePreviewPerformanceConfig.maxWriteDiffBytes);
    const bytes = summary(
      "write",
      { content: "new" },
      result("applied", { codePreviewBeforeWrite: { kind: "content", content: huge } }),
    );
    expect(noticeText(bytes)).toContain("large content");
    const lineCount =
      Math.ceil(Math.sqrt(codePreviewPerformanceConfig.maxWriteDiffChangedLineCells)) + 1;
    const complex = summary(
      "write",
      { content: "new\n".repeat(lineCount) },
      result("applied", {
        codePreviewBeforeWrite: { kind: "content", content: "old\n".repeat(lineCount) },
      }),
    );
    expect(noticeText(complex)).toContain("complex rewrite");
  });

  test("edit reports unavailable diffs without claiming failure", () => {
    const value = summary("edit", { path: "file" }, result("applied"));
    expect(value?.outcome).toBe("warning");
    expect(noticeText(value)).toContain("diff unavailable");
  });
});

describe("builtin factory compact integration", () => {
  const theme = Object.assign(testTheme(), { bg: (_key: string, text: string) => text });
  const args = {
    path: "file.ts",
    command: "printf value",
    pattern: "value",
    content: "proposedContent",
    edits: [{ oldText: "before", newText: "proposedContent" }],
  };
  function context(
    overrides: Partial<ToolRenderContext<FactoryState, typeof args>> = {},
  ): ToolRenderContext<FactoryState, typeof args> {
    return {
      args,
      state: { startedAt: undefined, endedAt: undefined, interval: undefined },
      cwd: "/project",
      toolCallId: "builtin-render-test",
      lastComponent: undefined,
      invalidate: () => undefined,
      executionStarted: false,
      argsComplete: true,
      expanded: false,
      isPartial: false,
      isError: false,
      showImages: true,
      ...overrides,
    };
  }

  test.each([
    ["read", createReadPreviewTool],
    ["bash", createBashPreviewTool],
    ["grep", createGrepPreviewTool],
    ["find", createFindPreviewTool],
    ["ls", createLsPreviewTool],
  ] as const)("%s hides ordinary output until expanded", (_name, factory) => {
    const tool = factory("/project");
    const ctx = context();
    const call = tool.renderCall?.(args, theme, ctx);
    expect(call).toBeDefined();
    const output = {
      content: [{ type: "text" as const, text: "hiddenOutputValue" }],
      details: undefined,
    };
    for (const isPartial of [true, false]) {
      const rendered = tool.renderResult?.(output, { expanded: false, isPartial }, theme, {
        ...ctx,
        executionStarted: true,
        isPartial,
      });
      const collapsed = [call, rendered]
        .flatMap((component) => (component ? [renderComponent(component)] : []))
        .join("\n");
      expect(collapsed).not.toContain("hiddenOutputValue");
    }
    const expandedContext = { ...ctx, executionStarted: true, expanded: true };
    const expandedCall = tool.renderCall?.(args, theme, expandedContext);
    const expandedResult = tool.renderResult?.(
      output,
      { expanded: true, isPartial: false },
      theme,
      expandedContext,
    );
    const expanded = [expandedCall, expandedResult]
      .flatMap((component) => (component ? [renderComponent(component)] : []))
      .join("\n");
    expect(expanded).toContain("hiddenOutputValue");
  });

  test("routine read pagination stays in unchanged expanded output, not compact attention", () => {
    for (const mode of ["on", "off", "border"] as const) {
      setCodePreviewSettings({ ...codePreviewSettings, toolCallBackground: mode });
      const tool = createReadPreviewTool("/project");
      const readArgs = { ...args, limit: 5 };
      const ctx = context({ args: readArgs });
      const output = result<undefined>(
        "selectedContent\n\n[73 more lines in file. Use offset=6 to continue.]",
      );
      const before = structuredClone(output);
      for (const expanded of [false, true, false, true]) {
        const renderContext = { ...ctx, expanded };
        const call = tool.renderCall?.(readArgs, theme, renderContext);
        const body = tool.renderResult?.(
          output,
          { expanded, isPartial: false },
          theme,
          renderContext,
        );
        const text = [call, body]
          .flatMap((component) => (component ? [renderComponent(component)] : []))
          .join("\n");
        expect(text.includes("offset=6")).toBe(expanded);
        expect(text.includes("selectedContent")).toBe(expanded);
      }
      expect(output).toEqual(before);
    }
  });

  test.each([
    ["read", createReadPreviewTool],
    ["bash", createBashPreviewTool],
    ["write", createWritePreviewTool],
    ["edit", createEditPreviewTool],
    ["grep", createGrepPreviewTool],
    ["find", createFindPreviewTool],
    ["ls", createLsPreviewTool],
  ] as const)("%s owns complete multipart failures once without the old card", (_name, factory) => {
    for (const mode of ["on", "off", "border"] as const) {
      setCodePreviewSettings({ ...codePreviewSettings, toolCallBackground: mode });
      const tool = factory("/project");
      const ctx = context({ isError: true });
      const output = {
        content: [
          { type: "text" as const, text: "failureLineOne" },
          { type: "text" as const, text: "Inspect the destination before retrying." },
        ],
        details: undefined,
      };
      for (const expanded of [false, true, false, true]) {
        const renderContext = { ...ctx, expanded };
        const call = tool.renderCall?.(args, theme, renderContext);
        const resultSlot = tool.renderResult?.(
          output,
          { expanded, isPartial: false },
          theme,
          renderContext,
        );
        const text = [call, resultSlot]
          .flatMap((component) => (component ? [renderComponent(component)] : []))
          .join("\n");
        expect(text.match(/failureLineOne/gu)).toHaveLength(1);
        expect(text.match(/Inspect the destination before retrying\./gu)).toHaveLength(1);
        expect(text.match(/file\.ts|printf value/gu)).toHaveLength(1);
      }
    }
  });

  test.each([
    ["write", createWritePreviewTool],
    ["edit", createEditPreviewTool],
  ] as const)("%s hides pending content until expanded", (_name, factory) => {
    const tool = factory("/project");
    const ctx = context();
    const collapsed = tool.renderCall?.(args, theme, ctx);
    expect(collapsed && renderComponent(collapsed)).not.toContain("proposedContent");
    const expanded = tool.renderCall?.(args, theme, { ...ctx, expanded: true });
    expect(expanded && renderComponent(expanded)).toContain("proposedContent");
  });
});

test("over-budget parsing declines compaction rather than clipping error or recovery text", () => {
  const output = "x".repeat(128 * 1024 + 1);
  expect(summary("bash", {}, result(output), "settled", { isError: true })).toBeUndefined();
  expect(summary("bash", { command: "x".repeat(16 * 1024 + 1) })).toBeUndefined();
  expect(
    summary("edit", { edits: Array.from({ length: 65 }, () => ({ oldText: "a", newText: "b" })) }),
  ).toBeUndefined();
});
