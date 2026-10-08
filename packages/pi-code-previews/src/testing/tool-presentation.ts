import {
  ToolExecutionComponent,
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { opaqueFixture, plainTheme, recordingExtensionHost } from "pi-cosmic-core/testing";
import type { CodePreviewSettings } from "../config/schema";
import { codePreviewSettings, setCodePreviewSettings } from "../config/state";
import type { CompactAnimationScheduler } from "../tools/compact-summary";
import type { AdaptableToolDefinition, AdaptableToolRenderers } from "../tools/cooperative-tools";
import type { ToolRenderContext } from "../tools/renderers/shared/types";

type RenderContext = ToolRenderContext<any, any>;

/** A pending, collapsed render context; each test passes only the fields it changes. */
export function renderContextFixture(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    args: {},
    toolCallId: "presentation-test",
    state: {},
    cwd: "/project",
    executionStarted: false,
    argsComplete: true,
    isPartial: true,
    expanded: false,
    showImages: true,
    isError: false,
    lastComponent: undefined,
    invalidate: () => undefined,
    ...overrides,
  };
}

/**
 * Publishes `overrides` over a snapshot of the current settings and returns its restore.
 * Keep settings applied through rendering: timing and preview flags are read at render time.
 * Effect tests can pair it with `Effect.acquireRelease`.
 */
export function applyPresentationSettings(overrides: Partial<CodePreviewSettings>): () => void {
  const snapshot = codePreviewSettings;
  setCodePreviewSettings({ ...snapshot, ...overrides });
  return () => setCodePreviewSettings(snapshot);
}

/** Runs `run` with `overrides` applied, restoring the snapshot even when it throws. */
export function withPresentationSettings<A>(
  overrides: Partial<CodePreviewSettings>,
  run: () => A,
): A {
  const restore = applyPresentationSettings(overrides);
  try {
    return run();
  } finally {
    restore();
  }
}

/** Registers through core's recording extension host; commands are recorded and never run. */
export function captureRegistrations(register: (pi: ExtensionAPI) => void) {
  const host = recordingExtensionHost();
  register(host.pi);
  return {
    tools: host.registrations,
    messageRenderers: host.messageRenderers,
    toolRenderers: host.toolRenderers,
    resolveToolRenderers: host.resolve,
  };
}

interface PresentationCycleOptions {
  /** Expansion states in order. Defaults to collapsed, expanded, collapsed, expanded. */
  readonly states?: readonly boolean[];
  /** Opt-in harness invalidation around each state's render. */
  readonly invalidate?: "before" | "after" | false;
  /** Extra context for a state, applied to both the call and the result. */
  readonly overrides?: (expanded: boolean) => Partial<RenderContext>;
}

export interface ToolPresentationHarness {
  call(args: RenderContext["args"], overrides?: Partial<RenderContext>): Component | undefined;
  result(result: AgentToolResult<any>, overrides?: Partial<RenderContext>): Component | undefined;
  render(width?: number): string[];
  invalidate(): void;
  /** Renders the call, then any result, once per state and returns each joined text. */
  cycle(
    args: RenderContext["args"],
    result?: AgentToolResult<any>,
    options?: PresentationCycleOptions,
  ): Array<{ readonly expanded: boolean; readonly text: string }>;
  readonly component: Component | undefined;
  readonly context: RenderContext;
}

/** Drives the registered render callbacks, never execute; independent of any test runner. */
export function createToolPresentationHarness(
  tool: Pick<AdaptableToolRenderers, "renderShell" | "renderCall" | "renderResult">,
  options: { theme?: Theme; width?: number; state?: object; cwd?: string } = {},
): ToolPresentationHarness {
  const theme = options.theme ?? plainTheme;
  let context = renderContextFixture({
    state: options.state ?? {},
    cwd: options.cwd ?? "/project",
    invalidate: () => invalidate(),
  });
  let call: Component | undefined;
  let result: Component | undefined;
  let callMounted = false;
  let resultValue: AgentToolResult<any> | undefined;
  const renderCall = () => {
    const render = tool.renderCall;
    call = render?.(context.args, theme, {
      ...context,
      lastComponent: call,
      invalidate: () => context.invalidate(),
    });
  };
  const renderResult = () => {
    if (!resultValue) return;
    const render = tool.renderResult;
    result = render?.(
      { content: resultValue.content, details: resultValue.details },
      { expanded: context.expanded, isPartial: context.isPartial },
      theme,
      { ...context, lastComponent: result, invalidate: () => context.invalidate() },
    );
  };
  /** Like ToolExecutionComponent.updateDisplay: the call, then any result, with fresh envelopes. */
  const update = () => {
    if (callMounted) renderCall();
    renderResult();
  };
  function invalidate() {
    call?.invalidate();
    result?.invalidate();
    update();
  }
  const harness: ToolPresentationHarness = {
    call(args, overrides = {}) {
      context = { ...context, ...overrides, args, lastComponent: call };
      callMounted = true;
      update();
      return call;
    },
    result(value, overrides = {}) {
      context = {
        ...context,
        executionStarted: true,
        isPartial: false,
        ...overrides,
        lastComponent: result,
      };
      resultValue = value;
      update();
      return result;
    },
    render(width = options.width ?? 80) {
      return [...(call?.render(width) ?? []), ...(result?.render(width) ?? [])];
    },
    invalidate,
    cycle(args, value, plan = {}) {
      return (plan.states ?? [false, true, false, true]).map((expanded) => {
        const state = { ...plan.overrides?.(expanded), expanded };
        if (plan.invalidate === "before") invalidate();
        harness.call(args, state);
        if (value) harness.result(value, state);
        const text = harness.render().join("\n");
        if (plan.invalidate === "after") invalidate();
        return { expanded, text };
      });
    },
    get component() {
      return call ?? result;
    },
    get context() {
      return context;
    },
  };
  return harness;
}

/**
 * Pi's own tool row, built once with the renderers it resolved, as history replay does, then
 * given `result` when there is one.
 */
export function hostToolRow<Args>(
  name: string,
  args: Args,
  renderers: ToolRenderers | undefined,
  options: {
    readonly cwd?: string;
    readonly id?: string;
    readonly result?: Parameters<ToolExecutionComponent["updateResult"]>[0];
  } = {},
): ToolExecutionComponent {
  const row = new ToolExecutionComponent(
    name,
    options.id ?? "replay",
    args,
    { showImages: false },
    renderers,
    opaqueFixture({ requestRender() {} }),
    options.cwd ?? "/project",
  );
  if (options.result) row.updateResult(options.result);
  return row;
}

/** A row's text after a reader sets its expansion, which invalidates it as Pi does. */
export function drawToolRow(row: ToolExecutionComponent, expanded = false, width = 120): string {
  row.setExpanded(expanded);
  row.invalidate();
  return row.render(width).join("\n");
}

/** A row's text collapsed, then expanded. */
export const toolRowFrames = (row: ToolExecutionComponent) => [
  drawToolRow(row, false),
  drawToolRow(row, true),
];

/** A fake `scheduleAnimation` owner that records scheduled ticks and released animations. */
export function animationSchedulerProbe() {
  let latest: (() => void) | undefined;
  let scheduled = 0;
  let stops = 0;
  const schedule: CompactAnimationScheduler = (_intervalMs, tick) => {
    latest = tick;
    scheduled += 1;
    return () => {
      stops += 1;
    };
  };
  return {
    schedule,
    /** Fires the most recently scheduled tick. */
    tick: () => latest?.(),
    get scheduled() {
      return scheduled;
    },
    get stops() {
      return stops;
    },
  };
}

type AnimationSchedulerProbe = ReturnType<typeof animationSchedulerProbe>;

/**
 * For each tool: renders a started pending call, fires the owner's newest tick, then settles
 * the result. Reports ticks scheduled, whether a tick invalidated the call, and stops, each
 * counted for that tool alone. Apply compact presentation settings around the call.
 */
export function probeAnimationOwnership(
  tools: readonly AdaptableToolDefinition[],
  scheduler: AnimationSchedulerProbe,
  options: {
    readonly args: (tool: AdaptableToolDefinition) => RenderContext["args"];
    readonly result?: (tool: AdaptableToolDefinition) => AgentToolResult<any>;
    readonly filter?: (tool: AdaptableToolDefinition) => boolean;
  },
) {
  return tools
    .filter((tool) => options.filter?.(tool) ?? true)
    .map((tool) => {
      const before = { scheduled: scheduler.scheduled, stops: scheduler.stops };
      let invalidations = 0;
      const harness = createToolPresentationHarness(tool);
      harness.call(options.args(tool), {
        executionStarted: true,
        invalidate: () => {
          invalidations += 1;
        },
      });
      harness.render();
      const scheduled = scheduler.scheduled - before.scheduled;
      if (scheduled > 0) scheduler.tick();
      const invalidated = invalidations > 0;
      harness.result(
        options.result?.(tool) ?? { content: [{ type: "text", text: "done" }], details: undefined },
      );
      harness.render();
      return { name: tool.name, scheduled, invalidated, stops: scheduler.stops - before.stops };
    });
}
