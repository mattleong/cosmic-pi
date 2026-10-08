// Test/benchmark boundary intentionally exercises native Pi, Node, Promise, timer, and environment APIs.
import type {
  AgentToolResult,
  EditToolDetails,
  EditToolInput,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import type { ToolRenderContext } from "../src/tools/renderers/shared/types";
import {
  benchLog,
  benchTheme,
  printBenchHeader,
  printLayerSummary,
  printResults,
  renderComponent,
  runBench,
} from "./helpers";

const {
  codePreviewPerformanceConfig,
  codePreviewSettings,
  setCodePreviewPerformanceConfig,
  setCodePreviewSettings,
} = await import("../src/config/state");
const { createBuiltinPreviewRenderers } = await import("../src/tools/renderers/registration");
// A no-op session scheduler, as live sessions always pass one. Older runs rendered without a
// scheduler, so their shell and timing-only numbers are not strictly comparable with these.
const createEditPreviewTool = (cwd: string) =>
  createBuiltinPreviewRenderers("edit", {
    cwd,
    selfShell: false,
    scheduleAnimation: () => () => undefined,
    enabledTools: ["edit"],
  })!;
const { startBenchmarkShikiSession } = await import("./shiki-session");

const WIDTH = 120;
let sink = 0;

type EditBenchmarkState = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2]["state"];

type RenderContext = ToolRenderContext<EditBenchmarkState, EditToolInput>;

type ToolResult = AgentToolResult<EditToolDetails | undefined>;

const previousSettings = { ...codePreviewSettings };
const previousPerformance = codePreviewPerformanceConfig;
const theme = benchTheme();
// The retained self shell also draws native-like preview backgrounds.
theme.bg = (key, text) => `${theme.getBgAnsi(key)}${text}\x1b[49m`;

setCodePreviewSettings({
  ...codePreviewSettings,
  editCollapsedLines: 160,
  editDiffPreview: true,
  syntaxHighlighting: true,
  toolCallBackground: "off",
  toolCallTiming: false,
  tools: ["edit"],
  wordEmphasis: "smart",
});
// Render synchronously so each sample measures the whole preview.
setCodePreviewPerformanceConfig({ ...codePreviewPerformanceConfig, asyncRenderChars: 100_000_000 });
const stopShiki = await startBenchmarkShikiSession(codePreviewSettings.shikiTheme);

try {
  printBenchHeader("edit renderer end-to-end");
  const edit = createEditPreviewTool("/tmp/project");
  const results = [];

  for (const benchCase of makeCallCases()) {
    results.push(
      runBench(benchCase.name, "renderCall+coldComponent", benchCase.mode, () => {
        const component = edit.renderCall!(
          benchCase.args,
          theme,
          callContext(benchCase.args, benchCase.expanded, {}),
        );
        sink += renderComponent(component, WIDTH).length;
      }),
    );

    const state: EditBenchmarkState = {};
    const warm = () =>
      edit.renderCall!(
        benchCase.args,
        theme,
        callContext(benchCase.args, benchCase.expanded, state),
      );
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

  const shellArgs = editArgs(1, 1);
  for (const mode of ["on", "off", "border"] as const) {
    setCodePreviewSettings({
      ...codePreviewSettings,
      toolCallBackground: mode,
      toolCallTiming: false,
    });
    const shellEdit = createEditPreviewTool("/tmp/project");
    const state: EditBenchmarkState = {};
    results.push(
      runBench("single edit shell adapter", "renderCall+component", mode, () => {
        const component = shellEdit.renderCall!(
          shellArgs,
          theme,
          callContext(shellArgs, false, state),
        );
        sink += renderComponent(component, WIDTH).length;
      }),
    );
  }

  setCodePreviewSettings({
    ...codePreviewSettings,
    toolCallBackground: "off",
    toolCallTiming: true,
  });
  const timingEdit = createEditPreviewTool("/tmp/project");
  const timingState: EditBenchmarkState = {};
  const timingContext = {
    ...callContext(shellArgs, false, timingState),
    executionStarted: true,
  };
  const firstTimingComponent = timingEdit.renderCall!(shellArgs, theme, timingContext);
  Object.assign(timingState, { codePreviewTimingOnlyRenderToken: 1 });
  results.push(
    runBench("single edit shell adapter", "renderCall+component", "timing-only cached", () => {
      const component = timingEdit.renderCall!(shellArgs, theme, {
        ...timingContext,
        lastComponent: firstTimingComponent,
      });
      sink += renderComponent(component, WIDTH).length;
    }),
  );

  printLayerSummary(results);
  benchLog(
    "Cold rows create fresh renderer state, render the preview component, and render it to TUI rows.",
  );
  benchLog("Cached rows reuse renderer state to measure preview-key/component caches.");
  benchLog("");
  printResults(results);
  if (sink === Number.MIN_SAFE_INTEGER) benchLog("sink", sink);
} finally {
  setCodePreviewSettings(previousSettings);
  setCodePreviewPerformanceConfig(previousPerformance);
  await stopShiki();
}

function callContext(
  args: EditToolInput,
  expanded: boolean,
  state: EditBenchmarkState,
): RenderContext {
  return {
    args,
    argsComplete: true,
    cwd: "/tmp/project",
    executionStarted: false,
    expanded,
    invalidate: () => undefined,
    isError: false,
    isPartial: true,
    lastComponent: undefined,
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
    ...callContext(args, expanded, state),
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
