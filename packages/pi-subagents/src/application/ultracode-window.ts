import type { WorkflowRunHandoff } from "../workflow/run-observer.ts";

export interface UltracodeWindow {
  readonly queuedRequests: number;
  readonly agentRunning: boolean;
  readonly holdsRun: boolean;
  readonly holdsNextRun: boolean;
  readonly runs: ReadonlyArray<string>;
}

export const closedUltracodeWindow: UltracodeWindow = Object.freeze({
  queuedRequests: 0,
  agentRunning: false,
  holdsRun: false,
  holdsNextRun: false,
  runs: [],
});

export const isUltracodeWindowOpen = (state: UltracodeWindow): boolean =>
  state.queuedRequests > 0 || state.holdsRun || state.holdsNextRun || state.runs.length > 0;

export const ultracodeWindowReset = (state: UltracodeWindow): UltracodeWindow => ({
  ...closedUltracodeWindow,
  agentRunning: state.agentRunning,
});

export const ultracodeRequestSent = (state: UltracodeWindow): UltracodeWindow =>
  state.agentRunning
    ? { ...state, holdsRun: true }
    : { ...state, queuedRequests: state.queuedRequests + 1 };

export const ultracodeRequestUnsent = (state: UltracodeWindow): UltracodeWindow => ({
  ...state,
  queuedRequests: Math.max(0, state.queuedRequests - 1),
});

export const ultracodePromptRunStarted = (
  state: UltracodeWindow,
  carriesRequest: boolean,
): UltracodeWindow => ({
  ...state,
  agentRunning: true,
  queuedRequests: 0,
  holdsRun: state.holdsRun || (carriesRequest && state.queuedRequests > 0),
});

export const ultracodeAgentRunStarted = (state: UltracodeWindow): UltracodeWindow => ({
  ...state,
  agentRunning: true,
  queuedRequests: 0,
  holdsRun: state.holdsRun || state.queuedRequests > 0,
});

export const ultracodeAgentRunSettled = (state: UltracodeWindow): UltracodeWindow => ({
  ...state,
  agentRunning: false,
  holdsRun: state.holdsNextRun,
  holdsNextRun: false,
});

export const ultracodeWorkflowRunOpened = (
  state: UltracodeWindow,
  runId: string,
): UltracodeWindow =>
  state.runs.includes(runId) ? state : { ...state, runs: [...state.runs, runId] };

export const ultracodeWorkflowRunClosed = (
  state: UltracodeWindow,
  runId: string,
  handoff: WorkflowRunHandoff,
): UltracodeWindow => {
  if (!state.runs.includes(runId)) return state;
  const runs = state.runs.filter((id) => id !== runId);
  return handoff === "next-turn" && state.agentRunning
    ? { ...state, runs, holdsNextRun: true }
    : { ...state, runs, holdsRun: true };
};
