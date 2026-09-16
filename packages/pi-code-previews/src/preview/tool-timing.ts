import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { synchronousNow } from "pi-cosmic-core";
import { captureCodePreviewSessionCapability } from "../application/capability";
import type { CompactAnimationScheduler } from "../tools/compact-summary";
import { codePreviewSettings } from "../config/state";
import type { RendererState } from "../tools/renderers/shared/types";
import { formatToolCallDuration } from "./format";

type ToolTimingUpdateContext = {
  state: unknown;
  executionStarted: boolean;
  isPartial: boolean;
  invalidate: () => void;
};

type ToolTimingRenderContext = ToolTimingUpdateContext & {
  lastComponent: Component | undefined;
};

export type TimingState = RendererState & {
  codePreviewTimingStartedAt?: number | undefined;
  codePreviewTimingEndedAt?: number | undefined;
  codePreviewTimingCancel?: (() => void) | undefined;
  codePreviewAnimationFrame?: number;
  codePreviewTimingCallComponent?: Component;
  codePreviewTimingResultComponent?: Component;
};

type ToolCallTiming = {
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
  const state = timingState(context);
  const resultComponent = render(
    withLastComponent(
      context,
      unwrapTimingComponent(state.codePreviewTimingResultComponent ?? context.lastComponent),
    ),
  );
  state.codePreviewTimingResultComponent = resultComponent;
  if (!timingLabel) return resultComponent;
  return new ToolTimingFooter(resultComponent, theme.fg("muted", `╰─ ${timingLabel}`));
}

export function updateToolCallTiming<TContext extends ToolTimingUpdateContext>(
  context: TContext,
  options: {
    animate?: boolean;
    formatLabel?: boolean;
    animateWithoutTiming?: boolean;
    scheduleAnimation?: CompactAnimationScheduler | undefined;
  } = {},
): ToolCallTiming | undefined {
  const state = timingState(context);
  if (!context.isPartial) clearToolCallTimingInterval(state);
  if (!codePreviewSettings.toolCallTiming) {
    if (options.animateWithoutTiming && context.executionStarted && context.isPartial)
      ensureToolCallAnimation(state, context.invalidate, options.scheduleAnimation);
    else clearToolCallTimingInterval(state);
    if (!context.isPartial && state.codePreviewTimingStartedAt !== undefined)
      state.codePreviewTimingEndedAt ??= synchronousNow();
    return undefined;
  }
  if (
    context.executionStarted &&
    state.codePreviewTimingStartedAt === undefined &&
    context.isPartial
  ) {
    state.codePreviewTimingStartedAt = synchronousNow();
    state.codePreviewTimingEndedAt = undefined;
  }

  const startedAt = state.codePreviewTimingStartedAt;
  if (startedAt === undefined) return undefined;
  if (context.isPartial === true && options.animate !== false)
    ensureToolCallAnimation(state, context.invalidate, options.scheduleAnimation);
  else if (context.isPartial === false) {
    state.codePreviewTimingEndedAt ??= synchronousNow();
    clearToolCallTimingInterval(state);
  }

  if (options.formatLabel === false) return undefined;
  const running = context.isPartial === true;
  const endTime = running ? synchronousNow() : (state.codePreviewTimingEndedAt ?? synchronousNow());
  const label = running ? "Elapsed" : "Took";
  const elapsedMs = Math.max(0, endTime - startedAt);
  const duration = formatToolCallDuration(elapsedMs);
  return { label: `${label} ${duration}`, duration, elapsedMs };
}

export function timingState(context: { state: unknown }): TimingState {
  // SAFETY: Pi initializes renderer state as an object shared by the call and result slots.
  return context.state as TimingState;
}

export function unwrapTimingComponent(component: Component | undefined): Component | undefined {
  return component instanceof TimingPreservedComponent ? component.component : component;
}

export function withLastComponent<TContext extends ToolTimingRenderContext>(
  context: TContext,
  lastComponent: Component | undefined,
): TContext {
  // SAFETY: This copy preserves all context fields except the explicitly replaced slot component.
  return { ...context, lastComponent } as TContext;
}

function ensureToolCallAnimation(
  state: TimingState,
  invalidate: () => void,
  scheduleAnimation?: CompactAnimationScheduler,
): void {
  const schedule = scheduleAnimation ?? captureCodePreviewSessionCapability()?.schedule;
  if (!schedule) return;
  state.codePreviewTimingCancel ??= schedule(100, () => {
    state.codePreviewAnimationFrame = (state.codePreviewAnimationFrame ?? 0) + 1;
    invalidate();
  });
}

function clearToolCallTimingInterval(state: TimingState): void {
  if (!state.codePreviewTimingCancel) return;
  state.codePreviewTimingCancel();
  state.codePreviewTimingCancel = undefined;
}

export class TimingPreservedComponent implements Component {
  readonly component: Component;

  constructor(component: Component) {
    this.component = component;
  }

  render(width: number): string[] {
    return this.component.render(width);
  }

  invalidate(): void {
    this.component.invalidate();
  }
}

class ToolTimingFooter implements Component {
  private readonly component: Component;
  private readonly footer: string;

  constructor(component: Component, footer: string) {
    this.component = component;
    this.footer = footer;
  }

  render(width: number): string[] {
    return [...this.component.render(width), truncateToWidth(this.footer, width, "")];
  }

  invalidate(): void {
    this.component.invalidate();
  }
}
