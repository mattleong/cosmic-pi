import * as Predicate from "effect/Predicate";

export type SubagentContextMode = "fresh" | "fork";
export type SubagentWriteIntent = "writer" | "read-only";
export type SubagentHost = "local";
export type SubagentRuntime = "pi" | "claude" | "codex";

export const SUBAGENT_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type SubagentEffort = (typeof SUBAGENT_EFFORTS)[number];

export const SUBAGENT_RUNTIME_EFFORTS = {
  pi: SUBAGENT_EFFORTS,
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max"],
} as const satisfies Readonly<Record<SubagentRuntime, ReadonlyArray<SubagentEffort>>>;

export const subagentRuntimeEfforts = (runtime: SubagentRuntime): ReadonlyArray<SubagentEffort> =>
  SUBAGENT_RUNTIME_EFFORTS[runtime];

export const subagentRuntimeSupportsEffort = (
  runtime: SubagentRuntime,
  effort: SubagentEffort,
): boolean => subagentRuntimeEfforts(runtime).includes(effort);

export const decodeSubagentEffort = <ValueInput>(value: ValueInput): SubagentEffort | undefined => {
  if (!Predicate.isString(value)) return undefined;
  const normalized = value.trim().toLowerCase();
  return SUBAGENT_EFFORTS.find((effort) => effort === normalized);
};
