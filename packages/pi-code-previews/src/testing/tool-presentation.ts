import {
  ToolExecutionComponent,
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { plainTheme, recordingExtensionHost, tuiFixture } from "pi-cosmic-core/testing";
import type { CodePreviewSettings } from "../config/schema";
import { codePreviewSettings, setCodePreviewSettings } from "../config/state";
import type { CompactAnimationScheduler } from "../tools/compact-summary";
import type { HostObject } from "../shared/untrusted-value";
import type { CodePreviewRenderers, ToolRenderContext } from "../tools/renderers/shared/types";

type EmptyRecord = Record<PropertyKey, never>;
type ContextFields = Omit<ToolRenderContext<EmptyRecord, EmptyRecord>, "args" | "state">;
type ContextOverrides<TState, TArgs> = Partial<ToolRenderContext<TState, TArgs>>;
type PresentableRenderers<TArgs, TDetails, TState> = CodePreviewRenderers<
  TArgs,
  TDetails,
  TState | EmptyRecord
>;

export function renderContextFixture<TArgs, TState>(
  overrides: ContextOverrides<TState, TArgs> & { readonly args: TArgs; readonly state: TState },
): ToolRenderContext<TState, TArgs>;
export function renderContextFixture<TArgs>(
  overrides: ContextOverrides<EmptyRecord, TArgs> & { readonly args: TArgs },
): ToolRenderContext<EmptyRecord, TArgs>;
export function renderContextFixture<TState>(
  overrides: ContextOverrides<TState, EmptyRecord> & { readonly state: TState },
): ToolRenderContext<TState, EmptyRecord>;
export function renderContextFixture(
  overrides?: Partial<ContextFields>,
): ToolRenderContext<EmptyRecord, EmptyRecord>;
export function renderContextFixture(
  overrides: ContextOverrides<unknown, unknown> = {},
): ToolRenderContext<unknown, unknown> {
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
    durationMs: undefined,
    outputPad: 1,
    ...overrides,
  };
}

export function applyPresentationSettings(overrides: Partial<CodePreviewSettings>): () => void {
  const snapshot = codePreviewSettings;
  setCodePreviewSettings({ ...snapshot, ...overrides });
  return () => setCodePreviewSettings(snapshot);
}

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

interface PresentationCycleOptions<TState, TArgs> {
  readonly states?: readonly boolean[];
  readonly invalidate?: "before" | "after" | false;
  readonly overrides?: (expanded: boolean) => ContextOverrides<TState, TArgs>;
}

type HarnessContext<TState, TArgs> = Omit<ToolRenderContext<TState, TArgs>, "args"> & {
  readonly args: TArgs | undefined;
};

export interface ToolPresentationHarness<TArgs = unknown, TDetails = unknown, TState = unknown> {
  call(args: TArgs, overrides?: ContextOverrides<TState, TArgs>): Component | undefined;
  result(
    result: AgentToolResult<TDetails>,
    overrides?: ContextOverrides<TState, TArgs>,
  ): Component | undefined;
  render(width?: number): string[];
  invalidate(): void;
  cycle(
    args: TArgs,
    result?: AgentToolResult<TDetails>,
    options?: PresentationCycleOptions<TState, TArgs>,
  ): Array<{ readonly expanded: boolean; readonly text: string }>;
  readonly component: Component | undefined;
  readonly context: HarnessContext<TState, TArgs>;
}

export function createToolPresentationHarness<TArgs, TDetails, TState = EmptyRecord>(
  tool: PresentableRenderers<TArgs, TDetails, TState>,
  options: { theme?: Theme; width?: number; state?: TState; cwd?: string } = {},
): ToolPresentationHarness<TArgs, TDetails, TState | EmptyRecord> {
  const theme = options.theme ?? plainTheme;
  const initialState: TState | EmptyRecord = options.state ?? {};
  let fields: Omit<ToolRenderContext<TState | EmptyRecord, TArgs>, "args"> = {
    ...renderContextFixture({ cwd: options.cwd ?? "/project", invalidate: () => invalidate() }),
    state: initialState,
  };
  let args: TArgs | undefined;
  let call: Component | undefined;
  let result: Component | undefined;
  let callMounted = false;
  let resultValue: AgentToolResult<TDetails> | undefined;
  const contextFor = (
    current: TArgs,
    lastComponent: Component | undefined,
  ): ToolRenderContext<TState | EmptyRecord, TArgs> => ({
    ...fields,
    args: current,
    lastComponent,
    invalidate: () => fields.invalidate(),
  });
  const renderCall = (current: TArgs) => {
    call = tool.renderCall?.(current, theme, contextFor(current, call));
  };
  const renderResult = (current: TArgs) => {
    if (!resultValue) return;
    result = tool.renderResult?.(
      { content: resultValue.content, details: resultValue.details },
      { expanded: fields.expanded, isPartial: fields.isPartial },
      theme,
      contextFor(current, result),
    );
  };
  const update = () => {
    if (args === undefined) return;
    if (callMounted) renderCall(args);
    renderResult(args);
  };
  function invalidate() {
    call?.invalidate();
    result?.invalidate();
    update();
  }
  const merge = (overrides: ContextOverrides<TState | EmptyRecord, TArgs>) => {
    const { args: overriddenArgs, ...rest } = overrides;
    fields = { ...fields, ...rest };
    if (overriddenArgs !== undefined) args = overriddenArgs;
  };
  const harness: ToolPresentationHarness<TArgs, TDetails, TState | EmptyRecord> = {
    call(nextArgs, overrides = {}) {
      merge(overrides);
      args = nextArgs;
      fields = { ...fields, lastComponent: call };
      callMounted = true;
      update();
      return call;
    },
    result(value, overrides = {}) {
      if (args === undefined) throw new Error("Call the tool before rendering its result.");
      fields = { ...fields, executionStarted: true, isPartial: false };
      merge(overrides);
      fields = { ...fields, lastComponent: result };
      resultValue = value;
      update();
      return result;
    },
    render(width = options.width ?? 80) {
      return [...(call?.render(width) ?? []), ...(result?.render(width) ?? [])];
    },
    invalidate,
    cycle(cycleArgs, value, plan = {}) {
      return (plan.states ?? [false, true, false, true]).map((expanded) => {
        const state = { ...plan.overrides?.(expanded), expanded };
        if (plan.invalidate === "before") invalidate();
        harness.call(cycleArgs, state);
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
      return { ...fields, args };
    },
  };
  return harness;
}

export function hostToolRow(
  name: string,
  args: HostObject,
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
    tuiFixture({ requestRender() {} }),
    options.cwd ?? "/project",
  );
  if (options.result) row.updateResult(options.result);
  return row;
}

export function drawToolRow(row: ToolExecutionComponent, expanded = false, width = 120): string {
  row.setExpanded(expanded);
  row.invalidate();
  return row.render(width).join("\n");
}

export const toolRowFrames = (row: ToolExecutionComponent) => [
  drawToolRow(row, false),
  drawToolRow(row, true),
];

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

type ProbedTool<TArgs, TDetails, TState> = PresentableRenderers<
  TArgs,
  TDetails | undefined,
  TState
> & { readonly name: string };

interface AnimationOwnershipRow {
  name: string;
  scheduled: number;
  invalidated: boolean;
  stops: number;
}

export function probeAnimationOwnership<TArgs, TDetails, TState>(
  tools: ReadonlyArray<ProbedTool<TArgs, TDetails, TState>>,
  scheduler: AnimationSchedulerProbe,
  options: {
    readonly args: (tool: ProbedTool<TArgs, TDetails, TState>) => TArgs;
    readonly result?: (
      tool: ProbedTool<TArgs, TDetails, TState>,
    ) => AgentToolResult<TDetails | undefined>;
    readonly filter?: (tool: ProbedTool<TArgs, TDetails, TState>) => boolean;
  },
) {
  const rows: AnimationOwnershipRow[] = [];
  for (const tool of tools) {
    if (!(options.filter?.(tool) ?? true)) continue;
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
    rows.push({ name: tool.name, scheduled, invalidated, stops: scheduler.stops - before.stops });
  }
  return rows;
}
