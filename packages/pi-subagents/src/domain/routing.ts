import { flow } from "effect/Function";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined } from "pi-cosmic-core";

export type SubagentContextMode = "fresh" | "fork";
export type SubagentWriteIntent = "writer" | "read-only";
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

/**
 * The supported effort nearest to `effort`, the way Pi clamps thinking levels: the next higher
 * supported level, else the next lower one. Unchanged when nothing is supported.
 */
export const clampSubagentEffort = (
  effort: SubagentEffort,
  supported: ReadonlyArray<SubagentEffort>,
): SubagentEffort => {
  if (supported.includes(effort)) return effort;
  const index = SUBAGENT_EFFORTS.indexOf(effort);
  return (
    SUBAGENT_EFFORTS.slice(index + 1).find((candidate) => supported.includes(candidate)) ??
    SUBAGENT_EFFORTS.slice(0, index).findLast((candidate) => supported.includes(candidate)) ??
    effort
  );
};

export const decodeSubagentEffort = flow(
  decodeUnknownOrUndefined(Schema.String),
  (text): SubagentEffort | undefined => {
    if (text === undefined) return undefined;
    const normalized = text.trim().toLowerCase();
    return SUBAGENT_EFFORTS.find((effort) => effort === normalized);
  },
);
