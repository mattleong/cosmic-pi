import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { extensionApiFixture } from "pi-cosmic-core/testing";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { galleryDirectory, galleryFrames, writeGallerySection } from "../testing";
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

const scenarios = [
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
] as const;

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
