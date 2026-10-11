import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { synchronousNow, formatDuration, formatElapsed, invokeHostCallback } from "pi-cosmic-core";
import * as Predicate from "effect/Predicate";
import { captureCodePreviewSessionCapability } from "../application/capability";
import type { CompactAnimationScheduler } from "../tools/compact-summary";
import { codePreviewSettings } from "../config/state";
import { clipToWidth, SPINNER_FRAME_MS } from "pi-cosmic-ui/manager";

type ToolTimingUpdateContext = {
  state: unknown;
  executionStarted: boolean;
  isPartial: boolean;
  invalidate: () => void;
};

type ToolTimingRenderContext = ToolTimingUpdateContext & {
  lastComponent: Component | undefined;
};

interface TimingOwner {
  readonly state: unknown;
}

interface TimingHandles {
  cancel: (() => void) | undefined;
  resultComponent: Component | undefined;
}

interface TimingState {
  readonly owner: TimingOwner;
  readonly handles: TimingHandles;
}

const TIMING_FIELDS = {
  startedAt: "codePreviewTimingStartedAt",
  endedAt: "codePreviewTimingEndedAt",
  animationFrame: "codePreviewAnimationFrame",
} as const;

type TimingField = keyof typeof TIMING_FIELDS;

const timingHandles = new WeakMap<object, TimingHandles>();

export const TIMING_VISIBLE_MS = 1_000;

export type ToolCallTiming = {
  label: string;
  duration: string;
  elapsedMs: number;
};

export function renderTimedResultFooter<TContext extends ToolTimingRenderContext>(
  context: TContext,
  theme: Theme,
  render: (context: TContext) => Component,
  timingLabel: string | undefined,
): Component {
  const handles = timingState(context)?.handles;
  const resultComponent = render(
    withLastComponent(context, handles?.resultComponent ?? context.lastComponent),
  );
  if (handles) handles.resultComponent = resultComponent;
  if (!timingLabel) return resultComponent;
  return new ToolTimingFooter(resultComponent, theme.fg("muted", `╰─ ${timingLabel}`));
}

type ToolCallTimingOptions = {
  animate?: boolean;
  formatLabel?: boolean;
  showShortTiming?: boolean | undefined;
  animateWithoutTiming?: boolean;
  scheduleAnimation?: CompactAnimationScheduler | undefined;
};

export function updateToolCallTiming<TContext extends ToolTimingUpdateContext>(
  context: TContext,
  options: ToolCallTimingOptions,
): ToolCallTiming | undefined {
  const state = timingState(context);
  if (!state) return undefined;
  if (!context.isPartial) clearToolCallTimingInterval(state);
  if (!codePreviewSettings.toolCallTiming) {
    updateUntimedAnimation(state, context, options);
    return undefined;
  }
  if (context.executionStarted && startedAt(state) === undefined && context.isPartial) {
    writeTiming(state.owner, "startedAt", synchronousNow());
    writeTiming(state.owner, "endedAt", undefined);
  }

  const started = startedAt(state);
  if (started === undefined) return undefined;
  if (!context.isPartial) settleEndedAt(state);
  else if (options.animate !== false)
    ensureToolCallAnimation(state, context.invalidate, options.scheduleAnimation);

  if (options.formatLabel === false) return undefined;
  return formatTiming(state, started, context.isPartial, options.showShortTiming);
}

function updateUntimedAnimation(
  state: TimingState,
  context: ToolTimingUpdateContext,
  options: ToolCallTimingOptions,
): void {
  if (options.animateWithoutTiming && context.executionStarted && context.isPartial)
    ensureToolCallAnimation(state, context.invalidate, options.scheduleAnimation);
  else clearToolCallTimingInterval(state);
  if (!context.isPartial && startedAt(state) !== undefined) settleEndedAt(state);
}

function formatTiming(
  state: TimingState,
  started: number,
  running: boolean,
  showShortTiming: boolean | undefined,
): ToolCallTiming | undefined {
  const endTime = running ? synchronousNow() : (endedAt(state) ?? synchronousNow());
  const elapsedMs = Math.max(0, endTime - started);
  if (!Number.isFinite(elapsedMs)) return undefined;
  if ((running || !showShortTiming) && elapsedMs < TIMING_VISIBLE_MS) return undefined;
  const duration = running ? formatElapsed(elapsedMs) : formatDuration(elapsedMs);
  return { label: `${running ? "Elapsed" : "Took"} ${duration}`, duration, elapsedMs };
}

function readTiming(owner: TimingOwner, field: TimingField): number | undefined {
  const state = owner.state;
  if (!Predicate.isObject(state)) return undefined;
  const value = state[TIMING_FIELDS[field]];
  return Predicate.isNumber(value) ? value : undefined;
}

function writeTiming(owner: TimingOwner, field: TimingField, value: number | undefined): void {
  const state = owner.state;
  if (Predicate.isObject(state)) state[TIMING_FIELDS[field]] = value;
}

const startedAt = (state: TimingState) => readTiming(state.owner, "startedAt");
const endedAt = (state: TimingState) => readTiming(state.owner, "endedAt");

function settleEndedAt(state: TimingState): void {
  if (endedAt(state) === undefined) writeTiming(state.owner, "endedAt", synchronousNow());
}

export function getCodePreviewAnimationFrame(context: { readonly state: unknown }): number {
  return invokeHostCallback(() => {
    const state = context.state;
    if (!Predicate.isObject(state) || Array.isArray(state)) return 0;
    const descriptor = Object.getOwnPropertyDescriptor(state, TIMING_FIELDS.animationFrame);
    const frame = descriptor && "value" in descriptor ? descriptor.value : undefined;
    return Predicate.isNumber(frame) && Number.isSafeInteger(frame) && frame >= 0 ? frame : 0;
  }, 0);
}

function timingState(context: { readonly state: unknown }): TimingState | undefined {
  const host = context.state;
  if (!Predicate.isObject(host)) return undefined;
  let handles = timingHandles.get(host);
  if (!handles) {
    handles = { cancel: undefined, resultComponent: undefined };
    timingHandles.set(host, handles);
  }
  return { owner: { state: host }, handles };
}

export function withLastComponent<TContext extends ToolTimingRenderContext>(
  context: TContext,
  lastComponent: Component | undefined,
): TContext {
  return { ...context, lastComponent };
}

function ensureToolCallAnimation(
  state: TimingState,
  invalidate: () => void,
  scheduleAnimation?: CompactAnimationScheduler,
): void {
  const schedule = scheduleAnimation ?? captureCodePreviewSessionCapability()?.schedule;
  if (!schedule) return;
  state.handles.cancel ??= schedule(SPINNER_FRAME_MS, () => {
    const frame = readTiming(state.owner, "animationFrame") ?? 0;
    writeTiming(state.owner, "animationFrame", frame + 1);
    invalidate();
  });
}

function clearToolCallTimingInterval(state: TimingState): void {
  if (!state.handles.cancel) return;
  state.handles.cancel();
  state.handles.cancel = undefined;
}

class ToolTimingFooter implements Component {
  private readonly component: Component;
  private readonly footer: string;
  private bounds: { width: number; height: number } | undefined;

  constructor(component: Component, footer: string) {
    this.component = component;
    this.footer = footer;
  }

  render(width: number): string[] {
    const rows = this.component.render(width);
    this.bounds = { width, height: rows.length };
    return [...rows, clipToWidth(this.footer, width, "")];
  }

  handleMouse(event: TuiMouseEvent) {
    const bounds = this.bounds;
    if (!bounds || event.width !== bounds.width || event.y < 0 || event.y >= bounds.height)
      return undefined;
    return this.component.handleMouse?.({ ...event, height: bounds.height });
  }

  invalidate(): void {
    this.bounds = undefined;
    this.component.invalidate();
  }
}
