import * as Effect from "effect/Effect";

/** Pi coalesces nested prompts into one start/end pair, not one pair per dialog. */
export const makeAskUserPromptGate = () => {
  let prompt: "idle" | "own" | "other" = "idle";
  let own = false;
  const waiting = new Set<() => void>();
  const canOpen = () => prompt === "idle" && !own;
  const wake = () => {
    if (canOpen()) for (const resume of waiting) resume();
  };
  return {
    started: () => {
      prompt = own ? "own" : "other";
    },
    ended: () => {
      prompt = "idle";
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
