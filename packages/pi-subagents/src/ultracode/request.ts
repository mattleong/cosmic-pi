/**
 * A one-off `/ultracode <task>` request: the task, an optional output-token budget written as
 * Claude Code's `+500k` prefix, and the user message that asks the main agent to run it as a
 * workflow.
 */
export interface UltracodeRequest {
  readonly task: string;
  /** Output tokens the workflow's agents may spend, from a `+500k`, `+1.5m` or `+200000` prefix. */
  readonly budget?: number | undefined;
}

const BUDGET_PREFIX = /^\+(\d+)(?:\.(\d+))?([km]?)(?:\s+|$)/iu;

const unitMultiplier = (unit: string): number => {
  const lower = unit.toLowerCase();
  if (lower === "k") return 1_000;
  if (lower === "m") return 1_000_000;
  return 1;
};

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
  const budget = (Number(`${whole}${fraction}`) * unitMultiplier(unit)) / 10 ** fraction.length;
  if (!Number.isSafeInteger(budget) || budget < 1) return { task: text };
  return { task: text.slice(prefix.length).trim(), budget };
};

/** The note's opening, which marks a prompt that carries a request. */
const REQUEST_NOTE =
  "The user asked for this request to run as a multi-agent workflow (/ultracode).";

/** The user message for the request, with the note that opts it into a workflow. */
export const ultracodeRequestMessage = (request: UltracodeRequest, guidePath: string): string => {
  const note = `${REQUEST_NOTE} Read the workflow authoring guide (${guidePath}) first, then write the workflow and start it with subagent_workflow. After starting it, end your turn: its notification starts your next turn, and you report from it then. Don't poll status or stop the run to finish sooner.`;
  const budget =
    request.budget === undefined
      ? ""
      : `\nToken budget: ${request.budget} output tokens: pass budget: ${request.budget} to subagent_workflow start.`;
  return `${request.task}\n\n${note}${budget}`;
};

/**
 * Whether a prompt carries a request's note. Pi passes the message through unexpanded, so a
 * prompt without the note didn't come from a request, even when one is still queued.
 */
export const carriesUltracodeRequest = (prompt: string): boolean => prompt.includes(REQUEST_NOTE);
