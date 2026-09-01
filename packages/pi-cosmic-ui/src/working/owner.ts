/** Working-run owner state machine that `application.ts` drives from Pi events. */
import * as Effect from "effect/Effect";
import type { WorkingTimerServiceContract } from "./service.ts";

export interface WorkingTimerActivation {
  readonly token: number;
  readonly timer: WorkingTimerServiceContract;
}

export interface WorkingOwnerHost {
  readonly isCurrent: (token: number) => boolean;
  /** Forks on the current session runtime; returns undefined when no fiber could be created. */
  readonly fork: (effect: Effect.Effect<void>) => object | undefined;
}

interface WorkingRunOwner {
  readonly token: number;
  readonly generation: number;
}

export const makeWorkingRunOwnerState = (host: WorkingOwnerHost) => {
  let workingTimer: WorkingTimerActivation | undefined;
  let workingRunGeneration = 0;
  let activeAgentOwner: WorkingRunOwner | undefined;
  let promptOwner: WorkingRunOwner | undefined;
  let releasedOwner: WorkingRunOwner | undefined;

  const sameWorkingOwner = (
    left: WorkingRunOwner | undefined,
    right: WorkingRunOwner | undefined,
  ): boolean =>
    left !== undefined &&
    right !== undefined &&
    left.token === right.token &&
    left.generation === right.generation;

  const admitWorkingTimer = (
    operation: (timer: WorkingTimerServiceContract) => Effect.Effect<void>,
    expectedToken?: number,
  ): number | undefined => {
    const activation = workingTimer;
    if (
      activation === undefined ||
      (expectedToken !== undefined && activation.token !== expectedToken) ||
      !host.isCurrent(activation.token)
    )
      return undefined;
    const fiber = host.fork(
      Effect.suspend(() =>
        workingTimer === activation && host.isCurrent(activation.token)
          ? operation(activation.timer)
          : Effect.void,
      ),
    );
    return fiber === undefined ? undefined : activation.token;
  };

  const admitWhen = (
    condition: () => boolean,
    operation: (timer: WorkingTimerServiceContract) => Effect.Effect<void>,
    expectedToken?: number,
  ): number | undefined =>
    admitWorkingTimer(
      (timer) => Effect.suspend(() => (condition() ? operation(timer) : Effect.void)),
      expectedToken,
    );

  return {
    /** Runtime activation: registers the current session's timer token. */
    activate(activation: WorkingTimerActivation): void {
      workingTimer = activation;
    },
    /** Runtime deactivation: clears the timer and both owners when the token matches. */
    deactivate(token: number): void {
      if (workingTimer?.token === token) workingTimer = undefined;
      if (activeAgentOwner?.token === token || promptOwner?.token === token) {
        workingRunGeneration += 1;
        activeAgentOwner = undefined;
        promptOwner = undefined;
      }
    },
    /** Session shutdown: clears run ownership without touching the timer activation. */
    clearRun(): void {
      workingRunGeneration += 1;
      activeAgentOwner = undefined;
      promptOwner = undefined;
    },
    /** Shared tail of `tool_execution_start` and `message_end`. */
    pauseOutputForActiveRun(): void {
      const owner = activeAgentOwner;
      if (!owner) return;
      admitWhen(
        () => sameWorkingOwner(activeAgentOwner, owner),
        (timer) => timer.pauseOutput,
        owner.token,
      );
    },
    /** `agent_start` tail: claim the run and start the timer once per generation. */
    startAgentRun(): void {
      const activation = workingTimer;
      if (!activation || !host.isCurrent(activation.token)) return;
      if (activeAgentOwner?.token === activation.token) return;
      const owner = { token: activation.token, generation: ++workingRunGeneration };
      activeAgentOwner = owner;
      promptOwner = undefined;
      admitWhen(
        () => sameWorkingOwner(activeAgentOwner, owner),
        (timer) => timer.start,
        owner.token,
      );
    },
    /** `agent_end` tail: settle the run and stop the timer when no newer claim exists. */
    settleAgentRun(): void {
      const owner = activeAgentOwner;
      if (!owner) return;
      activeAgentOwner = undefined;
      if (sameWorkingOwner(promptOwner, owner)) promptOwner = undefined;
      const settledGeneration = ++workingRunGeneration;
      admitWhen(
        () => activeAgentOwner === undefined && workingRunGeneration === settledGeneration,
        (timer) => timer.stop,
        owner.token,
      );
    },
    /** `ui_prompt_start` guard: a prompt can open only inside an unsettled agent run. */
    promptIdle(): boolean {
      return activeAgentOwner !== undefined && promptOwner === undefined;
    },
    /** `ui_prompt_start` tail after the caller's context update. */
    beginPrompt(): void {
      const owner = activeAgentOwner;
      if (!owner || promptOwner !== undefined) return;
      promptOwner = owner;
      admitWhen(
        () => sameWorkingOwner(activeAgentOwner, owner),
        (timer) => timer.waitForUser,
        owner.token,
      );
    },
    /**
     * `ui_prompt_end` head: releases the prompt owner and reports whether the run still
     * owns it. The matched owner is stored so it crosses the caller's context update
     * exactly as the original local did.
     */
    releasePrompt(): boolean {
      const owner = promptOwner;
      promptOwner = undefined;
      const matched = owner !== undefined && sameWorkingOwner(activeAgentOwner, owner);
      releasedOwner = matched ? owner : undefined;
      return matched;
    },
    /** `ui_prompt_end` tail after the caller's context update. */
    resumeAfterPrompt(): void {
      const owner = releasedOwner;
      releasedOwner = undefined;
      if (!owner) return;
      admitWhen(
        () => sameWorkingOwner(activeAgentOwner, owner) && promptOwner === undefined,
        (timer) => timer.resumeFromUser,
        owner.token,
      );
    },
    /** `message_update` tail: synchronous bounded accumulator ingress. */
    noteOutputCharacters(characters: number): void {
      const activation = workingTimer;
      if (
        activation === undefined ||
        activation.token !== activeAgentOwner?.token ||
        sameWorkingOwner(promptOwner, activeAgentOwner) ||
        !host.isCurrent(activation.token)
      )
        return;
      activation.timer.noteOutputCharacters(characters);
    },
  };
};

export type WorkingRunOwnerState = ReturnType<typeof makeWorkingRunOwnerState>;
