import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { applyPresentationSettings, renderContextFixture } from "../../../testing";
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
  codePreviewSettings,
  setCodePreviewPerformanceConfig,
  setCodePreviewSettings,
} from "../../../src/config/state";
import { createBuiltinCompactSummary } from "../../../src/tools/builtin-compact-summary";
import type { BuiltinCompactTool } from "../../../src/tools/builtin-subject";
import type { CompactPhase, CompactSummary } from "../../../src/tools/compact-summary";
import type { RendererState, ToolRenderContext } from "../../../src/tools/renderers/shared/types";
import { previewBodiesDisabled, textResult as result } from "../../support/render";
import * as Match from "effect/Match";

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
  resultValue?: AgentToolResult<unknown>,
  phase: CompactPhase = resultValue ? "settled" : "pending",
  overrides: Partial<ToolRenderContext<RendererState, Args>> = {},
): CompactSummary | undefined {
  return createBuiltinCompactSummary(tool, {
    phase,
    args,
    result: resultValue,
    context: renderContextFixture<Args, RendererState>({
      args,
      state: {},
      toolCallId: "compact-summary-test",
      argsComplete: phase !== "pending",
      executionStarted: phase === "running",
      isPartial: phase === "running",
      ...overrides,
    }),
  });
}

function codes(value: CompactSummary | undefined): string[] {
  expect(value).toBeDefined();
  return value?.issues?.map((issue) => issue.code) ?? [];
}

function issueFor(value: CompactSummary | undefined, code: string) {
  return value?.issues?.find((entry) => entry.code === code);
}

const tools: BuiltinCompactTool[] = ["read", "bash", "write", "edit", "grep", "find", "ls"];

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
    const details = Match.value(tool).pipe(
      Match.when("write", () => ({ codePreviewBeforeWrite: { kind: "content", content: "old" } })),
      Match.when("edit", () => ({ diff: "-1 old\n+1 new" })),
      Match.orElse(() => undefined),
    );
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
});

describe("issues independent of hidden preview bodies", () => {
  test.each(tools)("%s detects secrets in hidden result output", (tool) => {
    const value = summary(tool, {}, result(secret), "running");
    expect(codes(value)).toEqual(["possible-secrets"]);
    expect(issueFor(value, "possible-secrets")?.message).toContain("private key");
  });

  test("secret scanning keeps the bounded tail sample of large input", () => {
    const content = "x".repeat(codePreviewPerformanceConfig.secretScanChars * 2) + "\n" + secret;
    expect(codes(summary("write", { content }))).toContain("possible-secrets");
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
      expect(replay?.outcome).toBe("success");
      expect(codes(replay)).toEqual(["write-history-unavailable"]);
      expect(JSON.stringify(replay)).not.toMatch(/new file/i);
    }
  });
});
