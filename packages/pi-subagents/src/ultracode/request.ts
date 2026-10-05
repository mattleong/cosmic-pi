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
const REQUEST_NOTE = "The user opted this request into multi-agent workflows (/ultracode).";

/** The user message for the request, with the note that opts it into a workflow. */
export const ultracodeRequestMessage = (request: UltracodeRequest, guidePath: string): string => {
  const note = `${REQUEST_NOTE} Read the workflow authoring guide (${guidePath}) first, then scout the request yourself, reading the diff, code or docs it names. If the task is small enough to verify completely yourself, such as a diff of about ten changed lines or fewer, verify it yourself: trace each change through its callers, and once nothing is ambiguous, answer directly and say it needed no workflow. Independent agents verify findings you couldn't settle yourself, not ones you already confirmed. Otherwise write a workflow and start it with subagent_workflow. The goal is the most exhaustive, correct answer you can produce: token cost is not a constraint unless the request states a limit. Scale to what the request asks for (a diff review or "find any bugs" is a focused check: read it yourself first, then a few finders with concrete checklists that report every candidate they can back with a failing scenario, and one skeptic per distinct candidate, yours included; a thorough audit is a wide finder pool, a three-lens panel per finding and critic-proposed gap rounds; a multi-file implementation is the core built yourself, then four to six writers on disjoint files, then a review workflow of three to five lens reviewers with two skeptics per finding), pick the guide's quality patterns that fit, adversarially verify findings unless they are trivial or already verified, keep one task in one workflow (finding and verifying in the same script), and for multi-phase work run one workflow per phase, reading each result before the next. After starting a workflow, end your turn: its notification starts your next turn, and you report from it then. Don't poll status or stop the run to finish sooner.`;
  const budget =
    request.budget === undefined
      ? ""
      : `\nToken budget: ${request.budget} output tokens, the one limit on token cost: pass budget: ${request.budget} to subagent_workflow start and plan the run inside it.`;
  return `${request.task}\n\n${note}${budget}`;
};

/**
 * Whether a prompt carries a request's note. Pi passes the message through unexpanded, so a
 * prompt without the note didn't come from a request, even when one is still queued.
 */
export const carriesUltracodeRequest = (prompt: string): boolean => prompt.includes(REQUEST_NOTE);
