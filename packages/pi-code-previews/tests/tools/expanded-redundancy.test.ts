import { beforeEach, describe, expect, test } from "vitest";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { findOrUndefined } from "pi-cosmic-core/array";
import { applyPresentationSettings, createToolPresentationHarness } from "../../testing";
import {
  codemodeRenderers,
  nativeCall,
  scriptResult,
  settledSummary,
} from "../support/native-codemode";
import {
  builtinRenderers,
  occurrences,
  previewBodiesDisabled,
  stripAnsi,
  textResult,
} from "../support/render";
import { issueMessageStyleProblems } from "../../src/testing/issue-messages";

beforeEach(() =>
  applyPresentationSettings({
    syntaxHighlighting: false,
    toolCallTiming: false,
    toolCallCollapsedStyle: "compact",
    toolCallBackground: "off",
    ...previewBodiesDisabled,
  }),
);

type Harness = Pick<ReturnType<typeof createToolPresentationHarness>, "call" | "result" | "render">;

const expandedText = (
  harness: Harness,
  args: Parameters<Harness["call"]>[0],
  result: Parameters<Harness["result"]>[0],
  isError = false,
) => {
  harness.call(args, { expanded: true });
  harness.result(result, { expanded: true, isError });
  return stripAnsi(Arr.join(harness.render(120), "\n"));
};

const codemode = () => createToolPresentationHarness(codemodeRenderers());
const builtin = (name: "edit" | "write" | "bash") =>
  createToolPresentationHarness(builtinRenderers(name, true)!);

describe("codemode expansion states each fact once", () => {
  test("a thrown script error appears once and partial output stays readable", () => {
    const value = scriptResult(
      "failed",
      {
        calls: [nativeCall({ name: "bash", args: '{"command":"echo partial"}' })],
      },
      {
        type: "text",
        text: '{"output":"partial\\nsecond line\\n","exit_code":0}\nScript error:\nError: demo failure\n    at <anonymous> (codemode.js:2:7)\n\nTool calls made before the failure (they are not undone): bash (ok)',
      },
    );
    const text = expandedText(codemode(), { code: "throw new Error('demo failure')" }, value, true);
    expect(occurrences(text, "codemode.js:2:7")).toBe(1);
    expect(occurrences(text, "Tool calls made before the failure")).toBe(1);
    expect(text).toContain("second line");
    expect(text).not.toContain("\\n");
    expect(text).toContain("exit_code");
  });

  test("structured output keeps every key and value without escaped line breaks", () => {
    const value = scriptResult(
      "completed",
      { calls: [] },
      {
        type: "text",
        text: '==> text 1/2 <==\n{"output":"alpha\\nbeta\\n","truncated":false,"nested":{"list":["x",""]}}\n==> text 2/2 <==\nplain text',
      },
    );
    const text = expandedText(codemode(), { code: "return 1" }, value);
    for (const marker of [
      "alpha",
      "beta",
      "truncated",
      "false",
      "nested",
      "list",
      "x",
      '""',
      "plain text",
    ])
      expect({ marker, shown: Fn.pipe(text, Str.includes(marker)) }).toEqual({
        marker,
        shown: true,
      });
    expect(text).not.toContain("\\n");
  });

  test("an uncaught filesystem error reads as a human message and keeps the raw diagnostic", () => {
    const raw = "ENOENT: no such file or directory, open '/project/source.ts'";
    const summary = settledSummary(
      scriptResult(
        "failed",
        { calls: [nativeCall({ status: "error", error: raw })] },
        { type: "text", text: `Script error:\nError: ${raw}` },
      ),
      { isError: true },
    );
    const issues = Arr.flatMap(summary?.children?.entries ?? [], (entry) => entry.issues ?? []);
    const failure = findOrUndefined(issues, (issue) => issue.severity === "error");
    expect(failure?.message).not.toContain("ENOENT");
    expect(issueMessageStyleProblems(failure?.message ?? "")).toEqual([]);
    expect(failure?.detail).toContain(raw);
  });

  test("argument previews appear only when the call heading cannot show them", () => {
    const value = scriptResult(
      "completed",
      {
        calls: [
          nativeCall({ name: "read", args: '{"path":"/project/a.ts"}' }),
          nativeCall({
            id: "private/2",
            name: "write",
            args: '{"path":"/project/b.ts","content":"x"}',
          }),
        ],
      },
      { type: "text", text: "" },
    );
    const text = expandedText(codemode(), { code: "return 1" }, value);
    expect(occurrences(text, "/project/a.ts")).toBe(0);
    expect(text).toContain('"content":"x"');
  });
});

const editArgs = (oldText: string, newText: string) => ({
  path: "/project/a.ts",
  edits: [{ oldText, newText }],
});

describe("builtin expansion states each fact once", () => {
  test("an applied edit whose diff shows every requested line is not listed twice", () => {
    const text = expandedText(
      builtin("edit"),
      editArgs("const b = 2;", "const b = 20;"),
      textResult("Successfully replaced 1 block(s) in /project/a.ts.", {
        diff: " 1 const a = 1;\n-2 const b = 2;\n+2 const b = 20;\n 3 const c = 3;",
      }),
    );
    expect(occurrences(text, "const b = 20;")).toBe(1);
    expect(text).not.toContain("Successfully replaced");
  });

  test("an applied edit whose diff hides requested lines keeps the request", () => {
    const text = expandedText(
      builtin("edit"),
      editArgs("a = 1;\nkeep 1\nkeep 2\nb = 2;", "a = 10;\nkeep 1\nkeep 2\nb = 20;"),
      textResult("Successfully replaced 1 block(s) in /project/a.ts.", {
        diff: "-1 a = 1;\n+1 a = 10;\n 2 keep 1\n   ...\n-4 b = 2;\n+4 b = 20;",
      }),
    );
    expect(text).toContain("keep 2");
  });

  test("a failed edit keeps the requested text and any other result text stays visible", () => {
    const failed = expandedText(
      builtin("edit"),
      editArgs("const b = 2;", "const b = 20;"),
      textResult("Could not find the exact text in /project/a.ts.", {
        diff: "-2 const b = 2;\n+2 const b = 20;",
      }),
      true,
    );
    expect(failed).toContain("const b = 20;");
    const noted = expandedText(
      builtin("write"),
      { path: "/project/a.ts", content: "x" },
      textResult("Wrote with a warning: line endings changed"),
    );
    expect(noted).toContain("line endings changed");
  });

  test("a bash command the heading shows in full isn't repeated in the body", () => {
    const command = "git --no-pager diff --stat && node --version";
    const harness = builtin("bash");
    harness.call({ command }, { expanded: true });
    harness.result(textResult("v22.22.1"), { expanded: true });
    for (const width of [57, 120]) {
      const text = stripAnsi(Arr.join(harness.render(width), "\n"));
      expect(occurrences(text, command)).toBe(1);
    }
    // Too narrow for the heading: the body keeps the whole command.
    const narrow = stripAnsi(Arr.join(harness.render(30), "\n"));
    expect(
      occurrences(
        Fn.pipe(narrow, Str.replace(/\s+/gu, "")),
        Fn.pipe(command, Str.replace(/\s+/gu, "")),
      ),
    ).toBe(1);
  });

  test("a multi-line bash command shows once, labeled apart from its output", () => {
    const command = "cd packages/pi-code-previews\npnpm typecheck && pnpm test";
    const lines = Str.split(command, "\n");
    for (const style of ["preview", "compact"] as const) {
      applyPresentationSettings({ toolCallCollapsedStyle: style });
      const harness = builtin("bash");
      harness.call({ command }, { expanded: true });
      harness.result(textResult("Tests 1204 passed"), { expanded: true });
      const rows = Arr.map(harness.render(100), (row) => Str.trim(stripAnsi(row)));
      // A label is a row of its own, above the row it names, that shows none of the command.
      const labeled = (text: string) => {
        const above = findOrUndefined(rows, (_row, index) => rows[index + 1] === text) ?? "";
        return (
          Str.isNonEmpty(above) && !Arr.some(lines, (line) => Fn.pipe(above, Str.includes(line)))
        );
      };
      // The preview heading draws the exact command; a compact heading flattens it onto one
      // line, so the body shows it as written, labeled apart from its output.
      for (const line of lines)
        if (style === "preview")
          expect(Arr.filter(rows, (row) => Fn.pipe(row, Str.includes(line))).length).toBe(1);
        else expect(Arr.contains(rows, line)).toBe(true);
      expect(labeled(lines[0] ?? "")).toBe(style === "compact");
      // The output is labeled apart from the command's rows above it in either style.
      expect(labeled("Tests 1204 passed")).toBe(true);
    }
  });

  test("a bash failure's status is stated once while its output stays complete", () => {
    const text = expandedText(
      builtin("bash"),
      { command: "cat missing.txt" },
      textResult("cat: missing.txt: No such file or directory\n\nCommand exited with code 1"),
      true,
    );
    expect(occurrences(text, "code 1") + occurrences(text, "Exit 1")).toBe(1);
    expect(text).toContain("No such file or directory");
  });
});
