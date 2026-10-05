/**
 * The system-prompt guidance while workflows are opted in. Standing ultracode makes workflows
 * the default way to work; a one-off window covers only the request or runs that opened it.
 */
export type UltracodeGuidance =
  /** The ultracode setting is on. */
  | "standing"
  /** This agent run carries a `/ultracode` request. */
  | "request"
  /** A workflow run, or the notice about one, still needs the main agent. */
  | "runs";

/** How the main agent waits for a run: its notification starts the next turn. */
const WAIT_FOR_NOTIFICATION =
  "After starting a workflow, end your turn and report when its notification arrives; don't poll status or stop the run to finish sooner.";

export const ultracodeGuideline = (guidance: UltracodeGuidance, guidePath: string): string => {
  const guide = `Read the workflow authoring guide (${guidePath}) before writing a script.`;
  switch (guidance) {
    case "standing":
      return `Ultracode is on: the user opted into multi-agent workflows, and that opt-in is standing. Author and run a workflow with subagent_workflow for every substantive task by default. The goal is the most exhaustive, correct answer you can produce: token cost is not a constraint, except a budget the user gives (pass it as the start's budget). For multi-phase work (understand, design, implement, review), that often means several workflows in sequence, one per phase, so you stay in the loop between them; a single task such as a review or an audit stays one workflow, finding and verifying in the same script. Scale to what was asked: a diff review is a focused check (read it yourself first, then a few finders and one skeptic per distinct candidate), and panels, critics and loop-until-dry are for thorough audits. The guide's quality patterns (adversarial verify, multi-modal sweep, completeness critic, loop-until-dry) are the tools; pick what fits the task. Lean toward orchestrating with workflows and adversarially verifying your findings, unless the work is trivial or already verified. Work solo only on conversational turns, trivial mechanical edits and checks small enough to verify completely yourself, such as a diff of about ten changed lines or fewer whose every change you traced through its callers. ${WAIT_FOR_NOTIFICATION} ${guide}`;
    case "request":
      return `The user opted the current request into multi-agent workflows (/ultracode): scout it yourself first, then author and run a workflow for it with subagent_workflow, aiming for the most exhaustive, correct answer, unless the task is small enough to verify completely yourself, such as a diff of about ten changed lines or fewer whose every change you traced through its callers, which you answer directly. ${WAIT_FOR_NOTIFICATION} ${guide}`;
    case "runs":
      return `A workflow run the user opted into still needs you: use subagent_workflow for it (fix and resume; status when the user asks how it is going or a run seems stuck; stop only when they ask or the run is clearly broken) and handle other requests as usual. ${WAIT_FOR_NOTIFICATION} ${guide}`;
  }
};
