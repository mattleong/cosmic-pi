import * as Latch from "effect/Latch";

/** Pi coalesces nested prompts into one start/end pair, not one pair per dialog. */
export const makeAskUserPromptGate = () => {
  let promptActive = false;
  let own = false;
  // Open exactly while canOpen(); opening releases and forgets every current waiter.
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
    // Admission does not grant mount authority. A coalesced nested prompt can
    // still own input after our overlay closes, until the public end event.
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

export type AskUserPromptGate = ReturnType<typeof makeAskUserPromptGate>;
