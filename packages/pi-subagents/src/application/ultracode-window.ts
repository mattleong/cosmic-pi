import type { WorkflowRunHandoff } from "../workflow/run-observer.ts";

/**
 * The one-off `/ultracode` window. While it is open, workflows are available even with the
 * ultracode setting off: during the agent run that carries a request, while a workflow run is
 * open (live, or its notification not yet accepted), and during the agent run that handles an
 * accepted notification or notice. The transitions are pure; the application applies them from
 * Pi's lifecycle events, so the window needs no timers.
 */
export interface UltracodeWindow {
  /** Requests sent while no agent run was under way that no agent run has picked up yet. */
  readonly queuedRequests: number;
  /** An agent run is under way, from its start until it settles. */
  readonly agentRunning: boolean;
  /**
   * The current agent run, or the next one when none runs, carries the window's work: a request,
   * or a workflow notification or notice Pi accepted. The window stays open until it settles.
   */
  readonly holdsRun: boolean;
  /**
   * A notice Pi accepted during the current agent run waits for the next turn, so the agent run
   * after the current one handles it.
   */
  readonly holdsNextRun: boolean;
  /** Workflow runs that opened and haven't closed: live, or their notification not yet accepted. */
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

/** A session boundary closes the window; an agent run under way still settles. */
export const ultracodeWindowReset = (state: UltracodeWindow): UltracodeWindow => ({
  ...closedUltracodeWindow,
  agentRunning: state.agentRunning,
});

/**
 * A request was sent. Pi adds it to the agent run under way as a follow-up; otherwise it starts
 * a run from a prompt, which picks it up.
 */
export const ultracodeRequestSent = (state: UltracodeWindow): UltracodeWindow =>
  state.agentRunning
    ? { ...state, holdsRun: true }
    : { ...state, queuedRequests: state.queuedRequests + 1 };

/** A request queued for the next prompt never reached Pi. */
export const ultracodeRequestUnsent = (state: UltracodeWindow): UltracodeWindow => ({
  ...state,
  queuedRequests: Math.max(0, state.queuedRequests - 1),
});

/**
 * An agent run started from a prompt. When the prompt carries a queued request, the run holds
 * the window; queued requests it doesn't carry never reached Pi, so they are dropped.
 */
export const ultracodePromptRunStarted = (
  state: UltracodeWindow,
  carriesRequest: boolean,
): UltracodeWindow => ({
  ...state,
  agentRunning: true,
  queuedRequests: 0,
  holdsRun: state.holdsRun || (carriesRequest && state.queuedRequests > 0),
});

/**
 * An agent run started, possibly without a prompt, as a notification's run does. A request
 * still on its way joins it as a follow-up.
 */
export const ultracodeAgentRunStarted = (state: UltracodeWindow): UltracodeWindow => ({
  ...state,
  agentRunning: true,
  queuedRequests: 0,
  holdsRun: state.holdsRun || state.queuedRequests > 0,
});

/** The agent run settled: what it carried has been handled, and a waiting notice moves up. */
export const ultracodeAgentRunSettled = (state: UltracodeWindow): UltracodeWindow => ({
  ...state,
  agentRunning: false,
  holdsRun: state.holdsNextRun,
  holdsNextRun: false,
});

/** A workflow run started, or a notice about an interrupted one is being posted. */
export const ultracodeWorkflowRunOpened = (
  state: UltracodeWindow,
  runId: string,
): UltracodeWindow =>
  state.runs.includes(runId) ? state : { ...state, runs: [...state.runs, runId] };

/**
 * Pi accepted the run's notification or notice, or it needed none. The agent run that handles
 * it keeps the window open: the current one or the one the notification starts, or, for a notice
 * that waits for the next turn while an agent run is under way, the run after that.
 */
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
