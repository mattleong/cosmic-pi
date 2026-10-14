import * as Latch from "effect/Latch";

export const createAskUserPromptGate = () => {
  let promptActive = false;
  let own = false;
  const open = Latch.makeUnsafe(true);
  const canOpen = () => !promptActive && !own;
  const update = () => {
    if (canOpen()) open.openUnsafe();
    else open.closeUnsafe();
  };
  return {
    started: () => {
      promptActive = true;
      update();
    },
    ended: () => {
      promptActive = false;
      update();
    },
    canOpen,
    canQueue: () => own || canOpen(),
    awaitOpen: open.await,
    enter: () => {
      own = true;
      update();
      return () => {
        own = false;
        update();
      };
    },
  };
};

export type AskUserPromptGate = ReturnType<typeof createAskUserPromptGate>;
