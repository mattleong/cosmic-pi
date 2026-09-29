import type * as Schema from "effect/Schema";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { extensionApiFixture } from "pi-cosmic-core/testing";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  galleryDirectory,
  galleryFrames,
  writeGallerySection,
  withPresentationSettings,
  type GalleryScenario,
} from "../testing";
import { defaultCodePreviewSettings } from "../src/config/defaults";
import { codePreviewSettings, setCodePreviewSettings } from "../src/config/state";
import { ALL_CODE_PREVIEW_TOOLS } from "../src/tools/names";
import { registerToolRenderers } from "../src/tools/renderers/registration";
import { captureFreshNativeCodemode } from "../src/boundary/host-native-codemode";
import { styleNativeCodemode } from "../src/tools/native-codemode-render";

/** Registered builtin renderers in one collapsed style. */
function registered(style: "compact" | "preview") {
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    tools: [...ALL_CODE_PREVIEW_TOOLS],
    toolCallCollapsedStyle: style,
    toolCallTiming: false,
  });
  const tools = new Map<string, ToolDefinition>();
  registerToolRenderers(
    extensionApiFixture({
      getAllTools: () => [],
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    }),
    "/project",
    { toolOptions: {} },
  );
  const fresh = captureFreshNativeCodemode(
    extensionApiFixture({ getSettings: () => ({}), getAllTools: () => [], appendEntry() {} }),
  )!;
  tools.set(
    "codemode",
    styleNativeCodemode(fresh, () => undefined, "/project"),
  );
  return tools;
}

const text = (value: string): AgentToolResult<unknown> => ({
  content: [{ type: "text", text: value }],
  details: {},
});

interface NativeGalleryDetails {
  calls: unknown[];
  fullOutputPath?: string;
}
const nativeResult = (
  status: "completed" | "failed",
  calls: unknown[] = [],
  output = "Script output",
  fullOutputPath?: string,
): AgentToolResult<unknown> => {
  const details: NativeGalleryDetails = { calls };
  if (fullOutputPath) details.fullOutputPath = fullOutputPath;
  return {
    content: [
      { type: "text", text: `Script ${status}\nWall time 0.1 seconds\nOutput:\n` },
      { type: "text", text: output },
    ],
    details,
  };
};
const nativeCall = (status: string, error?: string) => {
  const call = { id: "private/1", name: "read", args: '{"path":"/project/source.ts"}', status };
  return error ? { ...call, error } : call;
};

type NativeArgumentCallInput = Schema.JsonObject;
const nativeArgumentCall = (name: string, args: NativeArgumentCallInput) => {
  const json = JSON.stringify(args);
  return {
    ...nativeCall("ok"),
    id: `private/${name}`,
    name,
    args: json.length > 200 ? `${json.slice(0, 197)}...` : json,
  };
};

const scenarios: ReadonlyArray<
  Omit<GalleryScenario, "args"> & {
    readonly tool: string;
    readonly args: object;
    readonly timing?: true;
    readonly narrow?: true;
  }
> = [
  {
    tool: "codemode",
    title: "native long single-line source",
    args: { code: "// SOURCE_HEAD " + "padding ".repeat(250) + " SOURCE_TAIL" },
    phase: "pending",
    narrow: true,
  },
  {
    tool: "codemode",
    title: "native no-call output is discoverable",
    args: { code: "text('Output is available');" },
    result: nativeResult("completed", [], "Output is available"),
  },
  {
    tool: "codemode",
    title: "native running without nested calls",
    args: { code: "await new Promise(resolve => setTimeout(resolve, 1000));" },
    phase: "running",
    result: { content: [], details: { calls: [] } },
  },
  {
    tool: "codemode",
    title: "native six mixed calls remain collapsed",
    args: { code: "await Promise.allSettled(checks);" },
    phase: "running",
    result: {
      content: [],
      details: {
        calls: Array.from({ length: 6 }, (_, index) => ({
          ...nativeCall(
            index === 0 ? "error" : index > 3 ? "running" : "ok",
            index === 0 ? "First check failed" : undefined,
          ),
          id: `private/${index}`,
          args: JSON.stringify({ path: `/project/check-${index}.ts` }),
        })),
      },
    },
  },
  {
    tool: "codemode",
    title: "native measured timing and cost",
    args: { code: "await runChecks();" },
    timing: true,
    result: nativeResult("completed", [
      { ...nativeCall("ok"), durationMs: 3200 },
      {
        ...nativeCall("ok"),
        name: "models.classify",
        args: "provider/classifier",
        durationMs: 2600,
        cost: 0.03,
      },
    ]),
  },
  {
    tool: "codemode",
    title: "native oversized ledger keeps bounded recent evidence",
    args: { code: "await runManyChecks();" },
    result: nativeResult(
      "completed",
      Array.from({ length: 257 }, (_, index) => ({
        ...nativeCall(
          index === 0 || index === 256 ? "error" : "ok",
          index === 0 ? "Older failure" : index === 256 ? "Recent failure" : undefined,
        ),
        id: `private/${index}`,
        args: JSON.stringify({ path: `/project/check-${index}.ts` }),
      })),
    ),
  },
  {
    tool: "codemode",
    title: "native mixed-invalid ledger preserves valid neighbors",
    args: { code: "await runChecks();" },
    result: nativeResult("completed", [
      nativeCall("ok"),
      { broken: true },
      nativeCall("error", "Retained failure"),
    ]),
  },
  {
    tool: "codemode",
    title: "native historical unfinished call is unconfirmed",
    args: { code: "void tools.read({path: 'source.ts'});" },
    result: nativeResult("completed", [nativeCall("running")]),
  },
  {
    tool: "codemode",
    title: "native program awaiting approval",
    args: { code: "text(await tools.read({path: 'source.ts'}));" },
    phase: "pending",
  },
  {
    tool: "codemode",
    title: "native nested call running",
    args: { code: "text(await tools.read({path: 'source.ts'}));" },
    phase: "running",
    result: { content: [], details: { calls: [nativeCall("running")] } },
  },
  {
    tool: "codemode",
    title: "native returned child is neutral",
    args: { code: "return await tools.read({path: 'source.ts'});" },
    result: nativeResult("completed", [nativeCall("ok")]),
  },
  {
    tool: "codemode",
    title: "native handled child error",
    args: { code: "try { await tools.read({path: 'source.ts'}); } catch { text('Handled'); }" },
    result: nativeResult("completed", [nativeCall("error", "File not found")], "Handled"),
  },
  {
    tool: "codemode",
    title: "native targets survive truncated argument previews",
    args: {
      code: "await tools.edit({path: 'src/file.ts', edits: [{oldText: largeText, newText: 'new'}]});\nawait tools.bash({command: longCommand});\nawait tools.background_task({action: 'start', name: 'Verify previews', command: longCommand});\nawait tools.mcp({action: 'tools.call', server: 'docs', tool: 'lookup', arguments: largeInput});",
    },
    result: nativeResult("completed", [
      nativeArgumentCall("edit", {
        path: "/project/src/file.ts",
        edits: [{ oldText: "old".repeat(200), newText: "new" }],
      }),
      nativeArgumentCall("bash", { command: "pnpm validate; ".repeat(40) }),
      nativeArgumentCall("background_task", {
        action: "start",
        name: "Verify previews",
        command: "pnpm validate; ".repeat(40),
      }),
      nativeArgumentCall("mcp", {
        action: "tools.call",
        server: "docs",
        tool: "lookup",
        arguments: { text: "x".repeat(400) },
      }),
    ]),
  },
  {
    tool: "codemode",
    title: "native script failure retains partial output",
    args: { code: "text('Partial output'); throw new Error('Failed to finish');" },
    isError: true,
    result: nativeResult(
      "failed",
      [],
      "Partial output\n\nScript error:\nError: Failed to finish\nNo tool calls were made",
    ),
  },
  {
    tool: "codemode",
    title: "native failed script retains abort diagnostic",
    args: { code: "await tools.read({path: 'source.ts'});" },
    isError: true,
    result: nativeResult(
      "failed",
      [nativeCall("cancelled")],
      "Script error:\nScript aborted: stopped",
    ),
  },
  {
    tool: "codemode",
    title: "native completed script leaves cancelled child uncertain",
    args: { code: "tools.read({path: 'source.ts'}); return 1;" },
    result: nativeResult("completed", [nativeCall("cancelled")], "1"),
  },
  {
    tool: "codemode",
    title: "native malformed historical details",
    args: { code: "return 'Historical output';" },
    result: {
      content: [{ type: "text", text: "Historical output" }],
      details: { calls: [{ old: true }] },
    },
  },
  {
    tool: "codemode",
    title: "native truncated output retains recovery",
    args: { code: "text('large output');" },
    result: nativeResult(
      "completed",
      [],
      "Warning: truncated output\nhead…tail\n[Full output: /tmp/native-output.txt (read with offset/limit)]",
      "/tmp/native-output.txt",
    ),
  },
  {
    tool: "codemode",
    title: "native truncated output could not be saved",
    args: { code: "text('large output');" },
    result: nativeResult(
      "completed",
      [],
      "Warning: truncated output (original token count: 20)\nTotal output lines: 1\n\nhead…tail\n\n[Could not save the full output: No such directory]",
    ),
  },
  {
    tool: "bash",
    title: "bash awaiting approval",
    args: { command: "rm -rf build" },
    phase: "pending",
  },
  {
    tool: "bash",
    title: "bash streaming output",
    args: { command: "pnpm test" },
    result: text("> vitest run\n\n RUN  v4.1.10 /project\n ✓ tests/a.test.ts (3 tests)"),
    phase: "running",
  },
  {
    tool: "bash",
    title: "bash success",
    args: { command: "pnpm lint" },
    result: text("Found 0 warnings and 0 errors."),
  },
  {
    tool: "bash",
    title: "bash cancelled",
    args: { command: "pnpm dev" },
    result: text("Command aborted"),
    isError: true,
  },
  {
    tool: "read",
    title: "read success",
    args: { path: "/project/src/a.ts" },
    result: text("export const a = 1;\nexport const b = 2;\n"),
  },
  {
    tool: "grep",
    title: "grep matches",
    args: { pattern: "TODO", path: "/project/src" },
    result: text("a.ts:3: // TODO fix the retry\nb.ts:9: // TODO remove after launch"),
  },
  {
    tool: "find",
    title: "find files",
    args: { pattern: "*.test.ts", path: "/project" },
    result: text("tests/a.test.ts\ntests/b.test.ts"),
  },
  {
    tool: "ls",
    title: "list a directory",
    args: { path: "/project" },
    result: text("src/\ntests/\npackage.json"),
  },
  {
    tool: "bash",
    title: "bash test failure",
    args: { command: "pnpm test" },
    result: text(
      "> vitest run\n\n FAIL  tests/auth.test.ts > rejects expired tokens\nAssertionError: expected 401 to be 200\n ELIFECYCLE  Test failed.\n\nCommand exited with code 1",
    ),
    isError: true,
  },
  {
    tool: "bash",
    title: "bash command not found",
    args: { command: "pnpx tsx build.ts" },
    result: text("Command exited with code 127"),
    isError: true,
  },
  {
    tool: "bash",
    title: "bash risky command",
    args: { command: "rm -rf build" },
    result: text("done"),
  },
  {
    tool: "read",
    title: "read missing file",
    args: { path: "/project/src/missing.ts" },
    result: text("ENOENT: no such file or directory, open '/project/src/missing.ts'"),
    isError: true,
  },
  {
    tool: "edit",
    title: "edit without a match",
    args: { path: "/project/src/a.ts", edits: [{ oldText: "a", newText: "b" }] },
    result: text(
      "Could not find the exact text in /project/src/a.ts. The old text must match exactly including all whitespace and newlines.",
    ),
    isError: true,
  },
  {
    tool: "write",
    title: "write with a possible secret",
    args: {
      path: "/project/.env",
      content: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    },
    result: text("Successfully wrote 60 bytes to /project/.env"),
  },
];

const directory = galleryDirectory(process.env) ?? "";

describe.skipIf(!directory)("presentation gallery", () => {
  it.effect("renders builtin tool scenarios in both collapsed styles", () =>
    Effect.gen(function* () {
      const saved = codePreviewSettings;
      const lines: string[] = [];
      try {
        for (const style of ["compact", "preview"] as const) {
          const tools = registered(style);
          for (const scenario of scenarios)
            lines.push(
              ...withPresentationSettings({ toolCallTiming: scenario.timing ?? false }, () =>
                galleryFrames(
                  tools.get(scenario.tool)!,
                  {
                    ...scenario,
                    title: `${style} · ${scenario.title}`,
                  },
                  scenario.narrow
                    ? [
                        { expanded: false, width: 16 },
                        { expanded: false, width: 60 },
                        { expanded: true, width: 40 },
                      ]
                    : undefined,
                ),
              ),
            );
        }
      } finally {
        setCodePreviewSettings(saved);
      }
      yield* writeGallerySection(directory, "pi-code-previews", lines);
    }),
  );
});
