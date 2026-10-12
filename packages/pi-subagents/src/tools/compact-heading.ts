import { getTextContent, type CompactPhase, type CompactSummary } from "pi-code-previews";
import * as Predicate from "effect/Predicate";
import { flow } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { countLabel } from "pi-cosmic-core";
import {
  type CompactSubagentToolDetails,
  type SubagentAwaitDetails,
  type SubagentRunCard,
  type SubagentStartDetails,
} from "./details-schema.ts";
import { decodeOutcomeDetails } from "./details-decode.ts";
import { decodeWorkspaceToolDetails } from "./compact-workspace-summary.ts";
import { countActionFailures } from "./outcome.ts";
import { rejectedCallIssue } from "./compact-action-failures.ts";

export interface SummaryArguments {
  action?: unknown;
  message?: unknown;
  runId?: unknown;
  runIds?: unknown;
  agents?: unknown;
  profile?: unknown;
  paths?: unknown;
}

const OPERATION_LABELS = new Map([
  ["list", "inspect"],
  ["resume_admission", "resume admission"],
]);

const operationLabel = (operation: string): string => OPERATION_LABELS.get(operation) ?? operation;

const decodeTargetIds = Schema.decodeUnknownOption(Schema.Array(Schema.String));

const targetIds = flow(
  decodeTargetIds,
  Option.map((decoded) => [...new Set(decoded.map((id) => id.trim()).filter(Boolean))]),
  Option.getOrUndefined,
);

export const requestedRunIds = (input: SummaryArguments): string[] | undefined =>
  targetIds(input.runIds);

export const requestedTargets = (input: SummaryArguments): string[] | undefined =>
  Predicate.isString(input.runId) ? targetIds([input.runId]) : requestedRunIds(input);

function startSubject(input: SummaryArguments): string {
  if (!Array.isArray(input.agents) || input.agents.length !== 1) return "";
  const agent: unknown = input.agents[0];
  if (!Predicate.isObject(agent)) return "";
  if ("name" in agent && Predicate.isString(agent.name)) return agent.name;
  return "profile" in agent && Predicate.isString(agent.profile) ? agent.profile : "";
}

function claimCounters(
  details: Exclude<CompactSubagentToolDetails, { action: "models" }>,
): string[] | undefined {
  const counts = details.cards.map((card) => card.writeClaimCount ?? card.writeClaims?.length);
  if (!counts.length || !counts.every((count) => count !== undefined)) return undefined;
  const count = countLabel(
    counts.reduce((sum, value) => sum + value, 0),
    "file claim",
  );
  return [
    details.runCount > details.cards.length
      ? `${details.cards.length}/${details.runCount} shown, ${count}`
      : count,
  ];
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
  const counters =
    action === "claims" && Array.isArray(input.paths)
      ? [`${countLabel(input.paths.length, "file claim")} requested`]
      : Array.isArray(input.agents)
        ? [`${input.agents.length} requested`]
        : ids && ids.length > 1
          ? [countLabel(ids.length, "subagent")]
          : [];
  const summary: CompactSummary = { subject, counters, metadata: [] };
  if (operation !== action) summary.action = operationLabel(operation);
  return summary;
}

const retrySuccessor = (
  details: SubagentStartDetails | SubagentAwaitDetails | CompactSubagentToolDetails,
): SubagentRunCard | undefined =>
  details.action === "retry" && details.cards.length === 1 ? details.cards[0] : undefined;

const displayName = (card: SubagentRunCard | undefined, ids: readonly string[]): string =>
  card && card.name !== card.id && !ids.includes(card.name) ? card.name : "";

const listedSubject = (
  details: SubagentStartDetails | SubagentAwaitDetails | CompactSubagentToolDetails,
): string =>
  details.action === "list" || details.action === "status"
    ? displayName(details.cards.length === 1 ? details.cards[0] : undefined, [])
    : "";

export function projectedSubject(
  details: SubagentStartDetails | SubagentAwaitDetails | CompactSubagentToolDetails,
  input: SummaryArguments,
  phase: CompactPhase,
  subject: string,
  targets?: readonly string[],
): string {
  if (details.action === "models" && Predicate.isString(input.profile)) return input.profile;
  const requested = targets ?? requestedTargets(input);
  if (requested?.length === 1 && "cards" in details)
    return displayName(
      details.cards.find((entry) => entry.id === requested[0]) ?? retrySuccessor(details),
      requested,
    );
  if (subject || phase !== "settled" || requested?.length) return subject;
  return listedSubject(details) || subject;
}

function receiptCounter(
  details: Exclude<CompactSubagentToolDetails, { action: "models" }>,
  receipt: string,
): string {
  const failures = countActionFailures(details.action, details.actionFailures);
  const exceptional = [
    [failures.pending, "awaiting confirmation"],
    [failures.unconfirmed, "unconfirmed"],
    [failures.failed, "failed"],
  ] as const;
  const problems = exceptional.filter(([count]) => count > 0);
  if (problems.length === 0)
    return details.runCount === 1 ? receipt : `${details.runCount} ${receipt}`;
  return [...(details.runCount > 0 ? [[details.runCount, receipt] as const] : []), ...problems]
    .map(([count, word]) => `${count} ${word}`)
    .join(", ");
}

export function applyArgumentLanes(
  summary: CompactSummary,
  details: SubagentStartDetails | SubagentAwaitDetails | CompactSubagentToolDetails,
  phase: CompactPhase,
  lanes: CompactSummary,
): void {
  if (details.action === "claims")
    summary.counters = claimCounters(details) ?? summary.counters ?? [];
  if (phase === "settled" && (details.action === "send" || details.action === "reply")) {
    const count = receiptCounter(details, details.action === "send" ? "sent" : "replied");
    summary.counters = [
      details.runCount > details.cards.length
        ? `${count}, ${details.cards.length}/${details.runCount} shown`
        : count,
    ];
  }
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
  if (action === "list") return "subagents";
  const ids = requestedRunIds(input);
  return (ids?.length ?? 0) > 1 || Array.isArray(input.agents) ? "the subagents" : "the subagent";
}

export function rejectedCall(
  input: SummaryArguments,
  action: string,
  operation: string,
  lanes: CompactSummary,
  result: { readonly content: Parameters<typeof getTextContent>[0]; readonly details?: unknown },
): CompactSummary | undefined {
  if (isTypedReceipt(result)) return undefined;
  const misplacedGuidance =
    action === "lifecycle" &&
    operation !== "resume" &&
    operation !== "retry" &&
    Predicate.isString(input.message);
  const issue = rejectedCallIssue(
    action === "claims" ? action : operation,
    getTextContent(result.content),
    rejectedTarget(input, action),
  );
  return {
    ...lanes,
    counters: [],
    outcome: "error",
    issues: [
      misplacedGuidance ? { ...issue, message: "Guidance can only be sent with a resume" } : issue,
    ],
  };
}
