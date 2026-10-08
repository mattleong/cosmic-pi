import { WORKFLOW_SCALING_GUIDANCE } from "./guidance.ts";

/**
 * A one-off `/ultracode <task>` request: the task, an optional output-token budget written as
 * Claude Code's `+500k` prefix, and the user message that opts it into workflows.
 */
export interface UltracodeRequest {
  readonly task: string;
  /** Output tokens the workflow's agents may spend, from a `+500k`, `+1.5m` or `+200000` prefix. */
  readonly budget?: number | undefined;
}

const BUDGET_PREFIX = /^\+(\d+)(?:\.(\d+))?([km]?)(?:\s+|$)/iu;
const UNIT_MULTIPLIERS = new Map([
  ["k", 1_000],
  ["m", 1_000_000],
]);

/**
 * Splits a leading budget off the task. The prefix counts only when it is a positive whole
 * number of tokens followed by a space or nothing; anything else stays part of the task.
 */
export const parseUltracodeRequest = (args: string): UltracodeRequest => {
  const text = args.trim();
  const match = BUDGET_PREFIX.exec(text);
  if (!match) return { task: text };
  const [prefix, whole = "", fraction = "", unit = ""] = match;
  // Scaled from the digits, so a decimal such as 1.1k is exactly 1100.
  const multiplier = UNIT_MULTIPLIERS.get(unit.toLowerCase()) ?? 1;
  const budget = (Number(`${whole}${fraction}`) * multiplier) / 10 ** fraction.length;
  if (!Number.isSafeInteger(budget) || budget < 1) return { task: text };
  return { task: text.slice(prefix.length).trim(), budget };
};

/** The note's opening, which marks a prompt that carries a request. */
const REQUEST_NOTE = "The user opted this request into multi-agent workflows (/ultracode).";

/** The user message for the request, with the note that opts it into a workflow. */
export const ultracodeRequestMessage = (request: UltracodeRequest, guidePath: string): string => {
  const note = `${REQUEST_NOTE} ${WORKFLOW_SCALING_GUIDANCE} Read the workflow authoring guide (${guidePath}) before writing a script. After starting a workflow, end your turn: its notification starts your next turn, and you report from it then. Don't poll status or stop the run to finish sooner.`;
  const budget =
    request.budget === undefined
      ? ""
      : `\nToken budget: ${request.budget} output tokens: pass budget: ${request.budget} to subagent_workflow start and plan within it, allowing for already-running agents to overshoot.`;
  return `${request.task}\n\n${note}${budget}`;
};

/**
 * Whether a prompt carries a request's note. Pi passes the message through unexpanded, so a
 * prompt without the note didn't come from a request, even when one is still queued.
 */
export const carriesUltracodeRequest = (prompt: string): boolean => prompt.includes(REQUEST_NOTE);
