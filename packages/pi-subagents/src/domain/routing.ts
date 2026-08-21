/**
 * Leaf routing vocabulary shared by profiles, config, run orchestration, and backends.
 *
 * This module stays dependency-light — leaf utilities such as `effect/Predicate` only —
 * so profile and run models can both depend on it without forming a cycle.
 */

import * as Predicate from "effect/Predicate";

export type SubagentContextMode = "fresh" | "fork";
export type SubagentWriteIntent = "writer" | "read-only";
export type SubagentHost = "local" | "herdr";
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

/** Runtime-native effort policy shared by config, settings, and launch preflight. */
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

/** Decodes an untyped host-reported thinking level; unknown or malformed values are rejected. */
export const decodeSubagentEffort = <ValueInput>(value: ValueInput): SubagentEffort | undefined => {
  if (!Predicate.isString(value)) return undefined;
  const normalized = value.trim().toLowerCase();
  // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
  return (SUBAGENT_EFFORTS as ReadonlyArray<string>).includes(normalized)
    ? (normalized as SubagentEffort)
    : undefined;
};
