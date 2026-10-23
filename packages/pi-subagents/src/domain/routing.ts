import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
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

const SUBAGENT_RUNTIME_EFFORTS = {
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
  return Fn.pipe(
    Arr.findFirst(SUBAGENT_EFFORTS.slice(index + 1), (candidate) => supported.includes(candidate)),
    Option.orElse(() =>
      Arr.findLast(SUBAGENT_EFFORTS.slice(0, index), (candidate) => supported.includes(candidate)),
    ),
    Option.getOrElse(() => effort),
  );
};

export const decodeSubagentEffort = Fn.flow(
  decodeUnknownOrUndefined(Schema.String),
  (text): SubagentEffort | undefined => {
    if (text === undefined) return undefined;
    const normalized = Fn.pipe(text, Str.trim, Str.toLowerCase);
    return Option.getOrUndefined(
      Arr.findFirst(SUBAGENT_EFFORTS, (effort) => effort === normalized),
    );
  },
);
