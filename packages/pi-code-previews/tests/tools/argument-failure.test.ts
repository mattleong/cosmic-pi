import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { piArgumentRejection } from "pi-cosmic-core/testing/sdk";
import { beforeEach, describe, expect, test } from "vitest";
import {
  applyPresentationSettings,
  createToolPresentationHarness,
  issueMessageStyleProblems,
  renderContextFixture,
} from "../../testing";
import {
  projectBuiltinCompactSummary,
  type BuiltinCompactProjectionInput,
} from "../../src/tools/builtin-projection";
import type { BuiltinCompactTool } from "../../src/tools/builtin-subject";
import type { CompactIssue } from "../../src/tools/compact-issues";
import { resolveCompactSummary } from "../../src/tools/compact-summary";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";
import { nativeToolSearchSummary } from "../../src/tools/native-tool-search-summary";
import { nativeCall, scriptResult, settledSummary } from "../support/native-codemode";
import { builtinRenderers, stripAnsi } from "../support/render";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Option from "effect/Option";

// Pi generates the rejections, so a change to its wording fails these tests rather than leaving
// them to pass on stale text.
const MALFORMED_JSON = '{"pattern":"TODO" "limit":5}';
const piRejection = (argumentsText: string) => (name: string) =>
  piArgumentRejection(
    {
      name,
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, limit: { type: "number" } },
        required: ["pattern"],
      },
    },
    argumentsText,
  );
const malformed = piRejection(MALFORMED_JSON);
const notAnObject = piRejection('["TODO"]');
const mismatched = piRejection('{"pattern":"TODO","limit":"many"}');
const rejections = [malformed, notAnObject, mismatched];
const builtins: readonly BuiltinCompactTool[] = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
];

const text = (value: string): AgentToolResult<unknown> => ({
  content: [{ type: "text", text: value }],
  details: {},
});

const projection: BuiltinCompactProjectionInput = {
  phase: "settled",
  args: {},
  result: undefined,
  cwd: "/project",
  isError: true,
  beforeWrite: { kind: "unknown" },
  secretWarnings: true,
  bashWarnings: true,
  secretScanChars: 8000,
  maxWriteDiffBytes: 100000,
  maxWriteDiffChangedLineCells: 10000,
};
const rejected = (tool: BuiltinCompactTool, value: string, args: Record<string, string> = {}) =>
  projectBuiltinCompactSummary(tool, { ...projection, args, result: text(value) });

const renderedLs = (
  args: Record<string, string>,
  result: AgentToolResult<unknown>,
  durationMs: number | undefined,
) =>
  Arr.map(
    createToolPresentationHarness(builtinRenderers("ls", true)!, { width: 200 }).cycle(
      args,
      result,
      {
        states: [false, true],
        overrides: () => ({ isError: true, isPartial: false, durationMs }),
      },
    ),
    (frame) => stripAnsi(frame.text),
  );

function expectArgumentIssue(issue: CompactIssue | undefined, value: string) {
  expect(issue).toMatchObject({ severity: "error", code: "invalid-arguments" });
  const message = issue?.message ?? "";
  expect({ message, problems: issueMessageStyleProblems(message) }).toEqual({
    message,
    problems: [],
  });
  expect(Fn.pipe(value, Str.startsWith(message))).toBe(false);
  expect(issue?.detail).toBeTruthy();
}

beforeEach(() => applyPresentationSettings({ toolCallTiming: false }));

describe("Pi argument rejections", () => {
  test("builtins explain each rejection briefly without inventing a subject", () => {
    for (const tool of builtins)
      for (const reject of rejections) {
        const value = reject(tool);
        const summary = rejected(tool, value);
        expect(summary).toMatchObject({ outcome: "error", subject: "" });
        expect(summary?.issues).toHaveLength(1);
        expectArgumentIssue(summary?.issues?.[0], value);
      }
    const args = { pattern: "TODO", limit: "many" };
    const settled = projectBuiltinCompactSummary("grep", {
      ...projection,
      args,
      isError: false,
      result: text("No matches found"),
    });
    expect(rejected("grep", mismatched("grep"), args)?.subject).toBe(settled?.subject);
  });

  test("the shared fallback and native producers classify rejections the same way", () => {
    const fallback = resolveCompactSummary(
      { subject: "work", outcome: "success" },
      "settled",
      true,
      mismatched("work"),
    );
    expect(fallback?.outcome).toBe("error");
    expectArgumentIssue(fallback?.issues?.[0], mismatched("work"));
    const search = nativeToolSearchSummary({
      phase: "settled",
      args: {},
      result: text(malformed("tool_search")),
      context: renderContextFixture({ isError: true, isPartial: false }),
    });
    expect(search?.outcome).toBe("error");
    expectArgumentIssue(search?.issues?.[0], malformed("tool_search"));
    const nested = settledSummary(
      scriptResult(
        "completed",
        { calls: [nativeCall({ status: "error", error: mismatched("read") })] },
        { type: "text", text: "done" },
      ),
    );
    const child = Option.getOrUndefined(
      Arr.findFirst(
        nested?.children?.entries[0]?.issues ?? [],
        ({ severity }) => severity === "error",
      ),
    );
    expect(child?.message).toBe(rejected("read", mismatched("read"))?.issues?.[0]?.message);
  });

  test("only a call Pi rejected before running loses the target its empty arguments imply", () => {
    const notFound = text("Path not found: /project");
    const rejection = text(malformed("ls"));
    for (const style of ["compact", "preview"] as const) {
      applyPresentationSettings({ toolCallCollapsedStyle: style });
      // Pi records a duration only for a call that ran.
      expect(renderedLs({}, notFound, 12)).toEqual(renderedLs({ path: "." }, notFound, 12));
      expect(renderedLs({}, rejection, undefined)).not.toEqual(
        renderedLs({ path: "." }, rejection, undefined),
      );
    }
  });

  test("collapsed rows hide the raw rejection while expansion keeps all of it", () => {
    const fallback = withCodePreviewShell(
      {
        name: "owned",
        label: "owned",
        description: "Owned tool",
        parameters: { type: "object", properties: {} },
        execute: () => Promise.resolve(text("unused")),
        renderCall: () => new Text("owned call", 0, 0),
        renderResult: (result, { expanded }) =>
          new Text(
            expanded
              ? (Option.getOrUndefined(
                  Arr.findFirst(result.content, (part) => part.type === "text"),
                )?.text ?? "")
              : "",
            0,
            0,
          ),
      },
      { compactSummary: () => ({ subject: "owned", outcome: "success" }) },
    );
    for (const style of ["compact", "preview"] as const) {
      applyPresentationSettings({ toolCallCollapsedStyle: style });
      const subjects = [
        ...Arr.map(builtins, (tool) => [tool, builtinRenderers(tool, true)!] as const),
        ["owned", fallback] as const,
      ];
      for (const [name, renderers] of subjects) {
        const value = malformed(name);
        const tool = createToolPresentationHarness(renderers, { width: 200 });
        const [collapsed, expanded] = Arr.map(
          tool.cycle({}, text(value), {
            states: [false, true],
            overrides: () => ({ isError: true }),
          }),
          (frame) => stripAnsi(frame.text),
        );
        expect(collapsed).not.toContain(`Invalid arguments for tool "${name}"`);
        expect(collapsed).not.toContain(MALFORMED_JSON);
        for (const line of Arr.filter(Str.split(value, "\n"), Str.isNonEmpty))
          expect(expanded).toContain(line);
      }
    }
  });
});
