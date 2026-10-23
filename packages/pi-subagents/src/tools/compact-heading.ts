import { getTextContent, type CompactPhase, type CompactSummary } from "pi-code-previews";
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
        Arr.filter(Boolean),
      ),
    ),
  ]),
  Option.getOrUndefined,
);

export const requestedRunIds = (input: SummaryArguments): string[] | undefined =>
  targetIds(input.runIds);

function startSubject(input: SummaryArguments): string {
  if (!Arr.isArray(input.agents) || input.agents.length !== 1) return "";
  const agent: unknown = input.agents[0];
  if (!Predicate.isObject(agent)) return "";
  if ("name" in agent && Predicate.isString(agent.name)) return agent.name;
  if ("agent" in agent && Predicate.isString(agent.agent)) return agent.agent;
  return "profile" in agent && Predicate.isString(agent.profile) ? agent.profile : "";
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
        : action === "workspace"
          ? "Proposed changes"
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
  if (requested?.length === 1 && "cards" in details)
    return displayName(
      Option.getOrUndefined(Arr.findFirst(details.cards, (entry) => entry.id === requested[0])),
      requested,
    );
  return subject;
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

export const isTypedReceipt = (result: { readonly details?: unknown }): boolean =>
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
  const text = getTextContent(result.content);
  const target = rejectedTarget(input, action);
  // Await and lifecycle failures lead with their code; other actions' text is classified as is.
  const coded =
    action === "await" || action === "lifecycle"
      ? codedActionFailureIssue(text, operation, { oneOfMany: target === "the subagents" })
      : undefined;
  return {
    ...lanes,
    counters: [],
    outcome: coded?.severity === "warning" ? "uncertain" : "error",
    issues: [coded ?? rejectedCallIssue(operation, text, target)],
  };
}
