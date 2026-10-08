/**
 * The system-prompt guidance while workflows are opted in. Standing ultracode covers later
 * requests too; a one-off window covers only the request or runs that opened it.
 */
export type UltracodeGuidance =
  /** The ultracode setting is on. */
  | "standing"
  /** This agent run carries a `/ultracode` request. */
  | "request"
  /** A workflow run, or the notice about one, still needs the main agent. */
  | "runs";

/** Shared authoring policy, not runtime limits or an effort classifier. */
export const WORKFLOW_SCALING_GUIDANCE = `Workflows are an orchestration mechanism, not a maximal-effort opt-in. Scout first to identify the user's intent, requirements and acceptance criteria. Clarify material requirement ambiguity; state reversible assumptions for cheap ambiguity instead of blocking on it. Match breadth to independent actual scope, depth to requested assurance plus uncertainty and gaps, and verification to consequences, reversibility and existing test evidence. A small sensitive change can be narrow and deep; a quick broad task gets limited, disclosed coverage. Implementation width follows independent ownership.

Work directly on simple tasks, or use a small steerable subagent_start group when workflow orchestration adds no value. Use subagent_workflow for meaningful repeated units, fan-out or dependencies. Before launching, briefly state the chosen scope, why parallel or staged work helps, and what evidence or stopping condition will finish it; this is a concise plan, not a routine approval request.

Start a justified first wave; schedule more only for concrete uncovered scope or unresolved questions. Stop scheduling once evidence supports the requested outcome, no justified next step remains, further work would only repeat evidence or resource limits intervene. Await already-started calls rather than cancelling them to finish sooner. Report coverage, unresolved questions and limits; agreement alone is not proof. A budget is a ceiling, not a spending target: reserve room for downstream verification and synthesis, account for in-flight work and possible concurrent overshoot, and do not expand work merely to spend what remains.`;

const GUIDANCE = {
  standing:
    "Ultracode is on: the user opted into multi-agent workflows for current and later requests while it remains on.",
  request: "The user opted only the current request into multi-agent workflows (/ultracode).",
  runs: "A workflow run the user opted into still needs you: use subagent_workflow for it (fix and resume; status when the user asks how it is going or a run seems stuck; stop only when they ask or the run is clearly broken) and handle other requests as usual.",
} as const satisfies Record<UltracodeGuidance, string>;

/**
 * Every guidance ends the same way: how the main agent waits for a run, whose notification
 * starts the next turn, and where the authoring guide is.
 */
export const ultracodeGuideline = (guidance: UltracodeGuidance, guidePath: string): string =>
  `${GUIDANCE[guidance]}${guidance === "runs" ? "" : ` ${WORKFLOW_SCALING_GUIDANCE}`} After starting a workflow, end your turn and report when its notification arrives; don't poll status or stop the run to finish sooner. Read the workflow authoring guide (${guidePath}) before writing a script.`;
