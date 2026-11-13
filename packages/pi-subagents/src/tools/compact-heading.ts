import type { CompactPhase, CompactSummary, getTextContent } from "pi-code-previews";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { countLabel } from "pi-cosmic-core/display";
import {
  type CompactSubagentToolDetails,
  type SubagentAwaitDetails,
  type SubagentRunCard,
  type SubagentStartDetails,
} from "./details-schema.ts";
import { decodeOutcomeDetails } from "./details-decode.ts";
import { decodeWorkspaceToolDetails } from "./compact-workspace-summary.ts";
import { codedActionFailureIssue, rejectedCallIssue } from "./compact-action-failures.ts";
import { rejectedFailure } from "./failure-details.ts";
import { findOrUndefined } from "pi-cosmic-core/array";

export interface SummaryArguments {
  action?: unknown;
  runIds?: unknown;
  agents?: unknown;
  profile?: unknown;
}

const decodeTargetIds = Schema.decodeUnknownOption(Schema.Array(Schema.String));

const targetIds = Fn.flow(
  decodeTargetIds,
  Option.map((decoded) => [
    ...new Set(
      Fn.pipe(
        decoded,
        Arr.map((id) => Str.trim(id)),
        Arr.filter(Str.isNonEmpty),
      ),
    ),
  ]),
  Option.getOrUndefined,
);

export const requestedRunIds = (input: SummaryArguments): string[] | undefined =>
  targetIds(input.runIds);

// Raw arguments: a launch names itself, its custom agent, or its profile.
const LaunchNaming = Schema.Struct({
  name: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  profile: Schema.optional(Schema.String),
});
const decodeLaunchNaming = Schema.decodeUnknownOption(LaunchNaming);

const launchLabel = (launch: typeof LaunchNaming.Type): string =>
  Str.trim(launch.name ?? launch.agent ?? launch.profile ?? "");

const MAX_LISTED_NAMES = 3;
const MAX_LISTED_NAME_CHARS = 48;

/**
 * A few short names read as a list in the heading. Undefined for more of them, a longer list, or
 * a blank name, which leave the subject to the counters.
 */
export const shortNameList = (names: ReadonlyArray<string>): string | undefined => {
  const joined = Arr.join(names, ", ");
  return names.length <= MAX_LISTED_NAMES &&
    Arr.every(names, Str.isNonEmpty) &&
    joined.length <= MAX_LISTED_NAME_CHARS
    ? joined
    : undefined;
};

/** The launch's name, or a short batch's names when every launch has one. */
function startSubject(input: SummaryArguments): string {
  if (!Arr.isArray(input.agents) || input.agents.length > MAX_LISTED_NAMES) return "";
  const labels = Arr.map(input.agents, (agent) =>
    Option.match(decodeLaunchNaming(agent), { onNone: () => "", onSome: launchLabel }),
  );
  return labels.length === 1 ? (labels[0] ?? "") : (shortNameList(labels) ?? "");
}

export function argumentSummary(
  input: SummaryArguments,
  action: string,
  operation: string,
): CompactSummary {
  const ids = requestedRunIds(input);
  const subject =
    action === "start"
      ? startSubject(input)
      : action === "models" && Predicate.isString(input.profile)
        ? input.profile
        : "";
  const counters = Arr.isArray(input.agents)
    ? [`${input.agents.length} requested`]
    : ids && ids.length > 1
      ? [countLabel(ids.length, "subagent")]
      : [];
  const summary: CompactSummary = { subject, counters, metadata: [] };
  if (operation !== action) summary.action = operation;
  return summary;
}

const displayName = (card: SubagentRunCard | undefined, ids: readonly string[]): string =>
  card && card.name !== card.id && !ids.includes(card.name) ? card.name : "";

export function projectedSubject(
  details: SubagentStartDetails | SubagentAwaitDetails | CompactSubagentToolDetails,
  input: SummaryArguments,
  subject: string,
  targets?: readonly string[],
): string {
  if (details.action === "models" && Predicate.isString(input.profile)) return input.profile;
  const requested = targets ?? requestedRunIds(input);
  if (!requested || !("cards" in details)) return subject;
  const names = Arr.map(requested, (id) =>
    displayName(
      findOrUndefined(details.cards, (entry) => entry.id === id),
      requested,
    ),
  );
  if (names.length === 1) return names[0] ?? subject;
  // A wait names a few runs it waited for, as a launch names its batch; its counter counts them.
  return details.action === "await" ? (shortNameList(names) ?? subject) : subject;
}

export function applyArgumentLanes(
  summary: CompactSummary,
  details: SubagentStartDetails | SubagentAwaitDetails | CompactSubagentToolDetails,
  phase: CompactPhase,
  lanes: CompactSummary,
): void {
  if (lanes.action) summary.action = lanes.action;
  if (phase !== "settled" && details.action !== "start" && details.action !== "await")
    summary.counters = lanes.counters ?? [];
}

const isTypedReceipt = (result: { readonly details?: unknown }): boolean =>
  decodeOutcomeDetails(result.details) !== undefined ||
  decodeWorkspaceToolDetails(result.details) !== undefined;

function rejectedTarget(input: SummaryArguments, action: string): string {
  if (action === "workspace") return "the proposed changes";
  if (action === "models") return "profile routes";
  const ids = requestedRunIds(input);
  return (ids?.length ?? 0) > 1 || Arr.isArray(input.agents) ? "the subagents" : "the subagent";
}

export function rejectedCall(
  input: SummaryArguments,
  action: string,
  operation: string,
  lanes: CompactSummary,
  result: { readonly content: Parameters<typeof getTextContent>[0]; readonly details?: unknown },
): CompactSummary | undefined {
  if (isTypedReceipt(result)) return undefined;
  const failure = rejectedFailure(result);
  const target = rejectedTarget(input, action);
  const runAction = action === "await" || action === "lifecycle";
  // Await and lifecycle failures are phrased from their code; other actions' text is classified.
  const coded = runAction
    ? codedActionFailureIssue(failure, operation, { oneOfMany: target === "the subagents" })
    : undefined;
  const ids = requestedRunIds(input) ?? [];
  // A run the call couldn't resolve has no name, and its ID shows only expanded, so the heading
  // keeps how many runs the call asked for.
  return {
    ...lanes,
    counters: runAction && ids.length > 0 ? [countLabel(ids.length, "subagent")] : [],
    outcome: coded?.severity === "warning" ? "uncertain" : "error",
    issues: [coded ?? rejectedCallIssue(operation, failure.message, target)],
  };
}
