import { WORKFLOW_SCALING_GUIDANCE } from "./guidance.ts";

export interface UltracodeRequest {
  readonly task: string;
  readonly budget?: number | undefined;
}

const BUDGET_PREFIX = /^\+(\d+)(?:\.(\d+))?([km]?)(?:\s+|$)/iu;
const UNIT_MULTIPLIERS = new Map([
  ["k", 1_000],
  ["m", 1_000_000],
]);

export const parseUltracodeRequest = (args: string): UltracodeRequest => {
  const text = args.trim();
  const match = BUDGET_PREFIX.exec(text);
  if (!match) return { task: text };
  const [prefix, whole = "", fraction = "", unit = ""] = match;
  const multiplier = UNIT_MULTIPLIERS.get(unit.toLowerCase()) ?? 1;
  const budget = (Number(`${whole}${fraction}`) * multiplier) / 10 ** fraction.length;
  if (!Number.isSafeInteger(budget) || budget < 1) return { task: text };
  return { task: text.slice(prefix.length).trim(), budget };
};

const REQUEST_NOTE = "The user opted this request into multi-agent workflows (/ultracode).";

export const ultracodeRequestMessage = (request: UltracodeRequest, guidePath: string): string => {
  const note = `${REQUEST_NOTE} ${WORKFLOW_SCALING_GUIDANCE} Read the workflow authoring guide (${guidePath}) before writing a script. After starting a workflow, end your turn: its notification starts your next turn, and you report from it then. Don't poll status or stop the run to finish sooner.`;
  const budget =
    request.budget === undefined
      ? ""
      : `\nToken budget: ${request.budget} output tokens: pass budget: ${request.budget} to subagent_workflow start and plan within it, allowing for already-running agents to overshoot.`;
  return `${request.task}\n\n${note}${budget}`;
};

export const carriesUltracodeRequest = (prompt: string): boolean => prompt.includes(REQUEST_NOTE);
