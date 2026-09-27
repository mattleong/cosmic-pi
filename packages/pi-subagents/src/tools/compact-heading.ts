/**
 * Compact headings from arguments and receipts: subjects, operation words, and receipt
 * counters. Run and workspace IDs never become subjects; they stay in expanded evidence.
 */
import type { CompactSummary, CompactSummaryProvider } from "pi-code-previews";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { countLabel } from "pi-cosmic-core";
import {
  WorkspaceToolDetailsSchema,
  decodeCompactToolDetails,
  decodeStartAwaitCardDetails,
  type CompactSubagentToolDetails,
  type SubagentAwaitDetails,
  type SubagentRunCard,
  type SubagentStartDetails,
} from "./details-schema.ts";
import { countActionFailures } from "./outcome.ts";
import { rejectedCallIssue } from "./compact-action-failures.ts";

export type Phase = Parameters<CompactSummaryProvider>[0]["phase"];

export interface SummaryArguments {
  action?: unknown;
  message?: unknown;
  runId?: unknown;
  runIds?: unknown;
  workspaceId?: unknown;
  agents?: unknown;
  profile?: unknown;
  paths?: unknown;
}

/** Operations named by a raw token read as words in headings. */
const OPERATION_LABELS = new Map([
  ["list", "inspect"],
  ["resume_admission", "resume admission"],
]);

const operationLabel = (operation: string): string => OPERATION_LABELS.get(operation) ?? operation;

export function requestedRunIds(input: SummaryArguments): string[] | undefined {
  return Array.isArray(input.runIds) && input.runIds.every(Predicate.isString)
    ? input.runIds
    : undefined;
}

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

/**
 * The heading before a receipt exists. Run and workspace IDs never become subjects: the
 * receipt names its runs, and a workspace is the proposal it holds.
 */
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

/** A retry returns its successor run, never the failed source it continues. */
const retrySuccessor = (
  details: SubagentStartDetails | SubagentAwaitDetails | CompactSubagentToolDetails,
): SubagentRunCard | undefined =>
  details.action === "retry" && details.cards.length === 1 ? details.cards[0] : undefined;

/** A card's display name, unless it is only an ID. */
const displayName = (card: SubagentRunCard | undefined, ids: readonly string[]): string =>
  card && card.name !== card.id && !ids.includes(card.name) ? card.name : "";

export function projectedSubject(
  details: SubagentStartDetails | SubagentAwaitDetails | CompactSubagentToolDetails,
  input: SummaryArguments,
  phase: Phase,
  subject: string,
  targets?: readonly string[],
): string {
  if (details.action === "models" && Predicate.isString(input.profile)) return input.profile;
  const requested =
    targets ?? (Predicate.isString(input.runId) ? [input.runId] : requestedRunIds(input));
  // A lone target is named by its card, or by a retry's successor. A target without a visible
  // card, or whose name is only an ID, stays unnamed; IDs are expanded-only detail.
  if (requested?.length === 1 && "cards" in details)
    return displayName(
      details.cards.find((entry) => entry.id === requested[0]) ?? retrySuccessor(details),
      requested,
    );
  if (subject || phase !== "settled" || requested?.length) return subject;
  if (details.action !== "list" && details.action !== "status") return subject;
  return displayName(details.cards.length === 1 ? details.cards[0] : undefined, []) || subject;
}

/**
 * "sent" for a lone confirmed target, else counts: "2 sent, 1 failed", "1 unconfirmed". A zero
 * beside a failure count says nothing the failure count does not.
 */
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
  phase: Phase,
  lanes: CompactSummary,
): void {
  if (details.action === "claims")
    summary.counters = claimCounters(details) ?? summary.counters ?? [];
  if (phase === "settled" && (details.action === "send" || details.action === "reply")) {
    // runCount counts confirmed operations, not failures or only the bounded visible cards.
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

const decodeWorkspaceReceipt = Schema.decodeUnknownOption(WorkspaceToolDetailsSchema);

/** Any typed receipt, whichever action it belongs to, rather than a rejected call's text. */
export const isTypedReceipt = <Details>(details: Details): boolean =>
  decodeStartAwaitCardDetails(details) !== undefined ||
  decodeCompactToolDetails(details) !== undefined ||
  decodeWorkspaceReceipt(details)._tag === "Some";

/** Whom a rejected call was about, in people's words. */
function rejectedTarget(input: SummaryArguments, action: string): string {
  if (action === "workspace") return "the proposed changes";
  if (action === "models") return "profile routes";
  if (action === "list") return "subagents";
  const ids = requestedRunIds(input);
  return (ids?.length ?? 0) > 1 || Array.isArray(input.agents) ? "the subagents" : "the subagent";
}

/**
 * A call rejected before it returned a receipt keeps its heading. Guidance on anything but a
 * resume is classified from the arguments; other text is quoted when people can read it.
 */
export function rejectedCall(
  input: SummaryArguments,
  action: string,
  operation: string,
  lanes: CompactSummary,
  text: string,
): CompactSummary {
  const misplacedGuidance =
    action === "lifecycle" &&
    operation !== "resume" &&
    operation !== "retry" &&
    Predicate.isString(input.message);
  const issue = rejectedCallIssue(
    action === "claims" ? action : operation,
    text,
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
