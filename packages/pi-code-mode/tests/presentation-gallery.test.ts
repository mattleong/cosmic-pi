import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { withCodePreviewShell } from "pi-code-previews";
import {
  applyPresentationSettings,
  galleryDirectory,
  galleryFrames,
  writeGallerySection,
} from "pi-code-previews/testing";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { CodeModeConfig } from "../src/config/schema.ts";
import { buildCodeModeToolDefinition } from "../src/tools/controller.ts";
import { executeHarness } from "./support/execute.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";

const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
  details: {},
});
const testFailure =
  "> vitest run\n\n FAIL  tests/auth.test.ts > rejects expired tokens\nAssertionError: expected 401 to be 200\n\nCommand exited with code 1";
const definitions = nestedToolDefinitionsFixture({
  bash: {
    execute: (_id: string, input: { command: string }) =>
      input.command === "ok" ? Promise.resolve(text("ok")) : Promise.reject(new Error(testFailure)),
  },
  read: {
    execute: (_id: string, input: { path: string }) =>
      input.path.startsWith("missing")
        ? Promise.reject(
            new Error(`ENOENT: no such file or directory, open '/project/${input.path}'`),
          )
        : Promise.resolve(text("contents")),
  },
  edit: {
    execute: (_id: string, input: { path: string }) =>
      Promise.reject(
        new Error(
          `Could not find the exact text in /project/${input.path}. The old text must match exactly including all whitespace and newlines.`,
        ),
      ),
  },
});

const scenarios: ReadonlyArray<readonly [string, string, Partial<CodeModeConfig>?]> = [
  [
    "test run fails",
    "await tools.pi.read({path:'package.json'});\nawait tools.pi.bash({command:'pnpm test'});",
  ],
  [
    "program handles failed calls",
    "const r = await Promise.allSettled([tools.pi.read({path:'a.ts'}), tools.pi.read({path:'missing-b.ts'}), tools.pi.edit({path:'src/x.ts', edits:[{oldText:'a',newText:'b'}]})]);\nreturn r.map((x) => x.status);",
  ],
  [
    "property of undefined",
    "const files = await tools.pi.read({path:'a.ts'});\nconst x = undefined;\nreturn x.map((y) => y);",
  ],
  ["invalid tool input", "await tools.pi.read({file:'a.ts'});"],
  ["caught invalid tool input", "try { await tools.pi.read({file:'a.ts'}); } catch {}\nreturn 1;"],
  ["unknown tool", "await tools.pi.grepp({pattern:'x'});"],
  ["syntax error", "const a = 1;\nconst b = ;"],
  ["unsupported syntax", "class A {}"],
  ["timeout", "while (true) {}", { timeoutMs: 100 }],
  [
    "call limit",
    "for (const p of ['a','b','c']) await tools.pi.read({path:p});",
    { maxToolCalls: 2 },
  ],
  ["thrown message", "throw new Error('No matching config found in 3 packages');"],
  ["non-data result", "return () => 1;"],
];

/** The registered Code Mode tool in the applied collapsed style; rendering never executes it. */
const registered = () => {
  const owned = buildCodeModeToolDefinition({
    catalogBudget: 0,
    includePowerShell: false,
    execute: () => Promise.reject(new Error("Rendering must not execute")),
    startUiTicker: () => () => undefined,
  });
  return withCodePreviewShell(owned, {
    mode: "off",
    compactSummary: owned.compactSummary,
    expandedContent: owned.expandedContent,
  });
};

const directory = galleryDirectory(process.env) ?? "";

describe.skipIf(!directory)("presentation gallery", () => {
  it.effect("renders Code Mode outcomes in both collapsed styles", () =>
    Effect.gen(function* () {
      const results: Array<{
        title: string;
        args: { code: string; intent: string };
        result: AgentToolResult<unknown>;
        isError: boolean;
      }> = [];
      for (const [title, code, config] of scenarios) {
        const harness = executeHarness({
          definitions,
          cwd: "/project",
          retainFailureDetails: true,
          ...(config && { config }),
        });
        const args = { code, intent: "Check the project" };
        const settled = yield* Effect.promise(() =>
          harness.run(code).then(
            (result) => ({ result, failure: undefined }),
            (error: Error) => ({ result: undefined, failure: error.message }),
          ),
        );
        if (settled.result) results.push({ title, args, result: settled.result, isError: false });
        else
          results.push({
            title,
            args,
            result: { ...text(settled.failure ?? ""), details: harness.retention.consume("call") },
            isError: true,
          });
      }
      const lines: string[] = [];
      for (const style of ["compact", "preview"] as const) {
        const restore = applyPresentationSettings({
          toolCallCollapsedStyle: style,
          toolCallTiming: false,
        });
        try {
          const tool = registered();
          for (const scenario of results)
            lines.push(
              ...galleryFrames(tool, { ...scenario, title: `${style} · ${scenario.title}` }),
            );
        } finally {
          restore();
        }
      }
      yield* writeGallerySection(directory, "pi-code-mode", lines);
    }),
  );
});
