/** Pi coalesces nested prompts into one start/end pair, not one pair per dialog. */
export const makeAskUserPromptGate = () => {
  let prompt: "idle" | "own" | "other" = "idle";
  let own = false;
  return {
    started: () => {
      prompt = own ? "own" : "other";
    },
    ended: () => {
      prompt = "idle";
    },
    canOpen: () => prompt === "idle" && !own,
    enter: () => {
      own = true;
      return () => {
        own = false;
      };
    },
  };
};

export type AskUserPromptGate = ReturnType<typeof makeAskUserPromptGate>;
