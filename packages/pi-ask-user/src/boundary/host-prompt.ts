import * as Effect from "effect/Effect";

/** Pi coalesces nested prompts into one start/end pair, not one pair per dialog. */
export const makeAskUserPromptGate = () => {
  let promptActive = false;
  let own = false;
  const waiting = new Set<() => void>();
  const canOpen = () => !promptActive && !own;
  const wake = () => {
    if (canOpen()) for (const resume of waiting) resume();
  };
  return {
    started: () => {
      promptActive = true;
    },
    ended: () => {
      promptActive = false;
      wake();
    },
    canOpen,
    // Admission does not grant mount authority. A coalesced nested prompt can
    // still own input after our overlay closes, until the public end event.
    canQueue: () => own || canOpen(),
    awaitOpen: Effect.callback<void>((resume) => {
      const ready = () => resume(Effect.void);
      if (canOpen()) ready();
      else waiting.add(ready);
      return Effect.sync(() => {
        waiting.delete(ready);
      });
    }),
    enter: () => {
      own = true;
      return () => {
        own = false;
        wake();
      };
    },
  };
};

export type AskUserPromptGate = ReturnType<typeof makeAskUserPromptGate>;
