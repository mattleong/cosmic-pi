import { describe, expect, it } from "@effect/vitest";
import {
  closedUltracodeWindow,
  isUltracodeWindowOpen,
  ultracodeAgentRunSettled,
  ultracodeAgentRunStarted,
  ultracodePromptRunStarted,
  ultracodeRequestSent,
  ultracodeRequestUnsent,
  ultracodeWindowReset,
  ultracodeWorkflowRunClosed,
  ultracodeWorkflowRunOpened,
  type UltracodeWindow,
} from "../../src/application/ultracode-window.ts";
import type { WorkflowRunHandoff } from "../../src/workflow/run-observer.ts";

type Step = (state: UltracodeWindow) => UltracodeWindow;

/** Applies each step in turn and records whether the window is open after it. */
const openAfter = (...steps: ReadonlyArray<Step>): ReadonlyArray<boolean> => {
  let state = closedUltracodeWindow;
  return steps.map((step) => {
    state = step(state);
    return isUltracodeWindowOpen(state);
  });
};

const sent: Step = ultracodeRequestSent;
/** A run started from the prompt a request sent. */
const requestPrompt: Step = (state) => ultracodePromptRunStarted(state, true);
/** A run started from a prompt that carries no request. */
const otherPrompt: Step = (state) => ultracodePromptRunStarted(state, false);
/** A run started without a prompt, as a notification's run does. */
const agentStarted: Step = ultracodeAgentRunStarted;
const settled: Step = ultracodeAgentRunSettled;
const opened =
  (runId: string): Step =>
  (state) =>
    ultracodeWorkflowRunOpened(state, runId);
const closed =
  (runId: string, handoff: WorkflowRunHandoff = "now"): Step =>
  (state) =>
    ultracodeWorkflowRunClosed(state, runId, handoff);

describe("the one-off ultracode window", () => {
  it("starts closed", () => {
    expect(isUltracodeWindowOpen(closedUltracodeWindow)).toBe(false);
  });

  it("stays open through the agent run a request's prompt starts", () => {
    expect(openAfter(sent, requestPrompt, settled)).toEqual([true, true, false]);
  });

  it("holds the agent run under way for a request sent as a follow-up", () => {
    expect(openAfter(otherPrompt, sent, settled)).toEqual([false, true, false]);
  });

  it("closes again when a request never reaches Pi", () => {
    expect(openAfter(sent, ultracodeRequestUnsent)).toEqual([true, false]);
  });

  it("drops a request whose prompt never ran when another prompt starts", () => {
    // Pi refused the request, for example without a model; the next prompt isn't the request.
    expect(openAfter(sent, otherPrompt, settled)).toEqual([true, false, false]);
  });

  it("lets a request on its way join a run a notification starts", () => {
    expect(openAfter(sent, agentStarted, settled)).toEqual([true, true, false]);
  });

  it("keeps a workflow run open past its request until its notification is handled", () => {
    expect(
      openAfter(sent, requestPrompt, opened("wf-1"), settled, closed("wf-1"), settled),
    ).toEqual([true, true, true, true, true, false]);
  });

  it("includes every run started while it is open, such as a resume", () => {
    expect(
      openAfter(opened("wf-1"), closed("wf-1"), opened("wf-2"), settled, closed("wf-2"), settled),
    ).toEqual([true, true, true, true, true, false]);
  });

  it("holds the next agent run for a notice that waits while an agent run is under way", () => {
    // The user stopped the run in Activity while the main agent worked on something else.
    expect(
      openAfter(
        sent,
        requestPrompt,
        opened("wf-1"),
        closed("wf-1", "next-turn"),
        settled,
        otherPrompt,
        settled,
      ),
    ).toEqual([true, true, true, true, true, true, false]);
  });

  it("holds only the next agent run for a waiting notice accepted while idle", () => {
    expect(openAfter(opened("wf-1"), closed("wf-1", "next-turn"), otherPrompt, settled)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("reopens for the next agent run when a run's notice is accepted", () => {
    // An interrupted run's notice opens the run, and its acceptance holds the next agent run.
    expect(
      openAfter(
        (state) => ultracodeWindowReset(state),
        opened("wf-1"),
        closed("wf-1", "next-turn"),
        otherPrompt,
        settled,
      ),
    ).toEqual([false, true, true, true, false]);
  });

  it("ignores a run it never opened", () => {
    expect(openAfter(closed("wf-other"))).toEqual([false]);
  });
});
