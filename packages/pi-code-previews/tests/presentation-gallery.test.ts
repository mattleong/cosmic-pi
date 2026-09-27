import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { extensionApiFixture } from "pi-cosmic-core/testing";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  galleryDirectory,
  galleryFrames,
  writeGallerySection,
  type GalleryScenario,
} from "../testing";
import { defaultCodePreviewSettings } from "../src/config/defaults";
import { codePreviewSettings, setCodePreviewSettings } from "../src/config/state";
import { ALL_CODE_PREVIEW_TOOLS } from "../src/tools/names";
import { registerToolRenderers } from "../src/tools/renderers/registration";

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
  return tools;
}

const text = (value: string): AgentToolResult<unknown> => ({
  content: [{ type: "text", text: value }],
  details: {},
});

const scenarios: ReadonlyArray<
  Omit<GalleryScenario, "args"> & { readonly tool: string; readonly args: object }
> = [
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
              ...galleryFrames(tools.get(scenario.tool)!, {
                ...scenario,
                title: `${style} · ${scenario.title}`,
              }),
            );
        }
      } finally {
        setCodePreviewSettings(saved);
      }
      yield* writeGallerySection(directory, "pi-code-previews", lines);
    }),
  );
});
