// Test/benchmark boundary intentionally exercises native Pi, Node, Promise, timer, and environment APIs.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/globalConsole:off
// @effect-diagnostics effect/globalDate:off
import type {
  AgentToolResult,
  EditToolDetails,
  EditToolInput,
  Theme,
  createEditToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  benchTheme,
  printBenchHeader,
  printLayerSummary,
  printResults,
  renderComponent,
  runBench,
} from "./helpers";

process.env.CODE_PREVIEW_TOOLS = "edit";
process.env.CODE_PREVIEW_ASYNC_RENDER_CHARS ??= "100000000";

const { codePreviewSettings, setCodePreviewSettings } = await import("../src/config/state");
const { registerToolRenderers } = await import("../src/tools/renderers/registration");
const { startBenchmarkShikiSession } = await import("./shiki-session");

const WIDTH = 120;
let sink = 0;

type NativeEditDefinition = ReturnType<typeof createEditToolDefinition>;
type EditBenchmarkState = Parameters<NonNullable<NativeEditDefinition["renderCall"]>>[2]["state"];

type Renderer = {
  name: string;
  renderCall?: (args: EditToolInput, theme: Theme, context: RenderContext) => Component;
  renderResult?: (
    result: ToolResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: Theme,
    context: RenderContext,
  ) => Component;
};

type RenderContext = {
  args?: unknown;
  argsComplete: boolean;
  cwd: string;
  executionStarted: boolean;
  expanded: boolean;
  invalidate: () => void;
  isError: boolean;
  isPartial: boolean;
  lastComponent?: Component;
  showImages: boolean;
  state: EditBenchmarkState;
  toolCallId: string;
};

type ToolResult = AgentToolResult<EditToolDetails | undefined>;

const previousSettings = { ...codePreviewSettings };
const theme = benchTheme();

setCodePreviewSettings({
  ...codePreviewSettings,
  editCollapsedLines: 160,
  editDiffPreview: true,
  syntaxHighlighting: true,
  toolCallBackground: "off",
  toolCallTiming: false,
  wordEmphasis: "smart",
});
const stopShiki = await startBenchmarkShikiSession(codePreviewSettings.shikiTheme);

try {
  printBenchHeader("edit renderer end-to-end");
  const edit = findRenderer(registerRenderers(), "edit");
  const results = [];

  for (const benchCase of makeCallCases()) {
    results.push(
      runBench(benchCase.name, "renderCall+coldComponent", benchCase.mode, () => {
        const component = edit.renderCall!(
          benchCase.args,
          theme,
          callContext(benchCase.expanded, {}),
        );
        sink += renderComponent(component, WIDTH).length;
      }),
    );

    const state: EditBenchmarkState = {};
    const warm = () =>
      edit.renderCall!(benchCase.args, theme, callContext(benchCase.expanded, state));
    sink += renderComponent(warm(), WIDTH).length;
    results.push(
      runBench(benchCase.name, "renderCall+cachedComponent", benchCase.mode, () => {
        sink += renderComponent(warm(), WIDTH).length;
      }),
    );
  }

  for (const benchCase of makeResultCases()) {
    applyResultCaseSettings(benchCase);
    results.push(
      runBench(benchCase.name, "renderResult+coldComponent", benchCase.mode, () => {
        const state: EditBenchmarkState = {};
        const component = edit.renderResult!(
          benchCase.result,
          { expanded: benchCase.expanded, isPartial: false },
          theme,
          resultContext(benchCase.args, benchCase.expanded, state),
        );
        sink += renderComponent(component, WIDTH).length;
      }),
    );

    const state: EditBenchmarkState = {};
    const warm = () =>
      edit.renderResult!(
        benchCase.result,
        { expanded: benchCase.expanded, isPartial: false },
        theme,
        resultContext(benchCase.args, benchCase.expanded, state),
      );
    sink += renderComponent(warm(), WIDTH).length;
    results.push(
      runBench(benchCase.name, "renderResult+cachedComponent", benchCase.mode, () => {
        sink += renderComponent(warm(), WIDTH).length;
      }),
    );
  }

  printLayerSummary(results);
  console.log(
    "Cold rows create fresh renderer state, render the preview component, and render it to TUI rows.",
  );
  console.log("Cached rows reuse renderer state to measure preview-key/component caches.");
  console.log("");
  printResults(results);
  if (sink === Number.MIN_SAFE_INTEGER) console.log("sink", sink);
} finally {
  setCodePreviewSettings(previousSettings);
  await stopShiki();
}

function registerRenderers(): Renderer[] {
  const registered: Renderer[] = [];
  // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
  registerToolRenderers(
    {
      registerTool: <Tool>(tool: Tool) => {
        // SAFETY: The benchmark captures the renderer definition registered by this package.
        registered.push(tool as Tool & Renderer);
      },
    } as never,
    "/tmp/project",
  );
  return registered;
}

function findRenderer(renderers: Renderer[], name: string): Renderer {
  const renderer = renderers.find((candidate) => candidate.name === name);
  if (!renderer?.renderCall || !renderer.renderResult) throw new Error(`Missing ${name} renderer`);
  return renderer;
}

function callContext(expanded: boolean, state: EditBenchmarkState): RenderContext {
  return {
    argsComplete: true,
    cwd: "/tmp/project",
    executionStarted: false,
    expanded,
    invalidate: () => undefined,
    isError: false,
    isPartial: true,
    showImages: true,
    state,
    toolCallId: "bench-edit",
  };
}

function resultContext(
  args: EditToolInput,
  expanded: boolean,
  state: EditBenchmarkState,
): RenderContext {
  return {
    ...callContext(expanded, state),
    args,
    executionStarted: true,
    isPartial: false,
  };
}

function makeCallCases(): Array<{
  name: string;
  mode: string;
  args: EditToolInput;
  expanded: boolean;
}> {
  return [
    {
      name: "single small proposed edit",
      mode: "collapsed",
      args: editArgs(1, 1),
      expanded: false,
    },
    { name: "single small proposed edit", mode: "expanded", args: editArgs(1, 1), expanded: true },
    {
      name: "three multiline proposed edits",
      mode: "collapsed",
      args: editArgs(3, 24),
      expanded: false,
    },
    {
      name: "three multiline proposed edits",
      mode: "expanded",
      args: editArgs(3, 24),
      expanded: true,
    },
    {
      name: "hundred proposed edit blocks",
      mode: "collapsed",
      args: editArgs(100, 3),
      expanded: false,
    },
  ];
}

function makeResultCases(): Array<{
  name: string;
  mode: string;
  args: EditToolInput;
  result: ToolResult;
  expanded: boolean;
  editDiffPreview: boolean;
  syntaxHighlighting: boolean;
  wordEmphasis: "off" | "smart";
}> {
  const args = { path: "src/generated.ts", edits: [{ oldText: "old", newText: "new" }] };
  const medium = resultWithDiff(diffBlock(220, codeBefore, codeAfter));
  const large = resultWithDiff(diffBlock(900, codeBefore, codeAfter));
  return [
    {
      name: "medium applied diff",
      mode: "collapsed/smart/plain",
      args,
      result: medium,
      expanded: false,
      editDiffPreview: true,
      syntaxHighlighting: false,
      wordEmphasis: "smart",
    },
    {
      name: "medium applied diff",
      mode: "collapsed/hidden",
      args,
      result: medium,
      expanded: false,
      editDiffPreview: false,
      syntaxHighlighting: false,
      wordEmphasis: "smart",
    },
    {
      name: "medium applied diff",
      mode: "expanded/smart/highlight",
      args,
      result: medium,
      expanded: true,
      editDiffPreview: true,
      syntaxHighlighting: true,
      wordEmphasis: "smart",
    },
    {
      name: "large applied diff",
      mode: "collapsed/off/plain",
      args,
      result: large,
      expanded: false,
      editDiffPreview: true,
      syntaxHighlighting: false,
      wordEmphasis: "off",
    },
    {
      name: "large applied diff",
      mode: "collapsed/smart/plain",
      args,
      result: large,
      expanded: false,
      editDiffPreview: true,
      syntaxHighlighting: false,
      wordEmphasis: "smart",
    },
  ];
}

function applyResultCaseSettings(benchCase: ReturnType<typeof makeResultCases>[number]): void {
  setCodePreviewSettings({
    ...codePreviewSettings,
    editDiffPreview: benchCase.editDiffPreview,
    syntaxHighlighting: benchCase.syntaxHighlighting,
    wordEmphasis: benchCase.wordEmphasis,
  });
}

function editArgs(blocks: number, linesPerBlock: number): EditToolInput {
  return {
    path: "src/example.ts",
    edits: Array.from({ length: blocks }, (_, index) => ({
      oldText: Array.from({ length: linesPerBlock }, (__, line) =>
        codeBefore(index * linesPerBlock + line),
      ).join("\n"),
      newText: Array.from({ length: linesPerBlock }, (__, line) =>
        codeAfter(index * linesPerBlock + line),
      ).join("\n"),
    })),
  };
}

function resultWithDiff(diff: string): ToolResult {
  return {
    content: [{ type: "text", text: "ok" }],
    details: { diff, patch: diff },
  };
}

function diffBlock(
  count: number,
  before: (index: number) => string,
  after: (index: number) => string,
): string {
  return [
    ...Array.from({ length: count }, (_, index) => `- ${index + 1} ${before(index)}`),
    ...Array.from({ length: count }, (_, index) => `+ ${index + 1} ${after(index)}`),
  ].join("\n");
}

function codeBefore(index: number): string {
  return `const value${index} = source.oldName${index % 9}(input${index}) ?? fallback.${index};`;
}

function codeAfter(index: number): string {
  return `const value${index} = target.newName${index % 9}(safeInput${index}) ?? fallback.${index};`;
}
