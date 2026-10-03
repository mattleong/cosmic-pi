/**
 * Human messages for failed target operations and rejected calls. The service's own text is
 * agent-facing: it names run IDs and tool calls, so it stays in each issue's expanded detail.
 */
import type { CompactIssue, CompactSummary } from "pi-code-previews";
import { failureMessage, quoteText } from "pi-cosmic-core";
import type { CompactToolActionFailure, SubagentRunCard } from "./details-schema.ts";
import {
  actionFailureDisposition,
  pendingDeliveryEvidence,
  unconfirmedActionRecovery,
  type ActionFailureDisposition,
} from "./outcome.ts";
import { failureRecovery } from "./render-management.ts";

type Phrase = (subject: string) => string;

/** [lower-cased code substrings, message]; the first match wins, so specific codes lead. */
const FAILURE_PHRASES: ReadonlyArray<readonly [ReadonlyArray<string>, Phrase]> = [
  [["workflow_owned_run"], (subject) => `${subject} reports to its workflow`],
  [["notfound", "not_found"], () => "A requested subagent was not found"],
  [["run_waiting_for_parent"], (subject) => `${subject} is waiting for a reply`],
  [["parent_question_missing"], (subject) => `${subject} has no question waiting for a reply`],
  [["question_ownership_mismatch"], (subject) => `${subject}'s question is no longer waiting`],
  [["question_transport_closed"], (subject) => `${subject}'s question was cancelled`],
  [["reply_send_failed"], (subject) => `${subject} didn't receive the reply`],
  [["too_large"], () => "The message is too long"],
  [["retry_route_exhausted"], (subject) => `${subject} has no profile options left to retry`],
  [["retry_claim", "retry_already"], (subject) => `${subject} is already being retried`],
  [["completion_claim_conflict"], (subject) => `${subject}'s outcome is claimed by another wait`],
  [
    ["report_delivery_backlog"],
    (subject) => `${subject}'s earlier outcome is still being delivered`,
  ],
  [
    ["write_claim_change_not_waiting"],
    (subject) => `${subject}'s claims can change only while it waits on a claim question`,
  ],
  [["write_claim"], () => "A requested file claim is invalid"],
  [["not_running"], (subject) => `${subject} isn't running`],
  [["run_starting"], (subject) => `${subject} is still starting`],
  [["in_flight"], (subject) => `${subject} is already handling a request`],
  [["state_invalid", "state_reclaimed"], (subject) => `${subject} can't do that right now`],
  [["resume_unavailable"], (subject) => `${subject} can't be resumed`],
  [["lifecycle_message_invalid"], () => "Guidance can only be sent with a resume"],
  [["capacity"], () => "No subagent capacity is left"],
  [["nesting_depth_limit"], () => "The subagent nesting limit was reached"],
];

const VERBS = new Map([
  ["send", "send guidance to"],
  ["reply", "reply to"],
  ["interrupt", "interrupt"],
  ["resume", "resume"],
  ["stop", "stop"],
  ["retry", "retry"],
  ["rename", "rename"],
  ["claims", "change claims for"],
  ["status", "find"],
  ["list", "list"],
  ["await", "wait for"],
  ["start", "start"],
  ["models", "inspect"],
  ["review", "review"],
  ["prepare", "prepare"],
  ["integrate", "integrate"],
  ["revise", "request a revision of"],
  ["discard", "discard"],
  ["progress", "send progress to"],
  ["warning", "send the warning to"],
  ["question", "ask"],
  ["report", "submit the report to"],
]);

// Service text written for the agent: tool calls, key=value arguments, or run IDs.
const AGENT_TEXT = /\bsubagent_[a-z_]+\b|\b\w+\(\s*\{|\b\w+=["\w]|\bagent-[\w-]+/u;

/** The first line of service text when people can read it, otherwise undefined. */
const readableFailure = (text: string, forbidden: readonly string[]): string | undefined => {
  const line = failureMessage(text, "");
  return line && !AGENT_TEXT.test(line) && !forbidden.some((id) => id && line.includes(id))
    ? line
    : undefined;
};

const NOUNS = new Map([
  ["send", "guidance"],
  ["reply", "reply"],
  ["interrupt", "interrupt"],
  ["resume", "resume"],
  ["stop", "stop"],
  ["retry", "retry"],
  ["rename", "rename"],
  ["claims", "claim change"],
]);

/** An outcome that may have applied: never phrased as a failure. */
const unconfirmedMessage = (action: string, name: string | undefined): string => {
  const noun = NOUNS.get(action) ?? "action";
  return name ? `${name}: the ${noun} couldn't be confirmed` : `The ${noun} couldn't be confirmed`;
};

/** "Couldn't stop auth-review" or "Couldn't stop the subagent". */
export const couldNot = (action: string, target: string): string =>
  `Couldn't ${VERBS.get(action) ?? action} ${target}`;

/** A definite failure in people's terms: its code's phrase, readable service text, or a fallback. */
export function failedActionMessage(
  action: string,
  failure: Pick<CompactToolActionFailure, "id" | "code" | "message">,
  name: string | undefined,
  oneOfMany = false,
): string {
  const code = failure.code?.toLowerCase() ?? "";
  const phrase = FAILURE_PHRASES.find(([codes]) => codes.some((needle) => code.includes(needle)));
  if (phrase) return phrase[1](name ?? (oneOfMany ? "A subagent" : "The subagent"));
  const readable = readableFailure(failure.message, [failure.id]);
  if (readable) return name ? `${name}: ${readable}` : readable;
  return couldNot(action, name ?? (oneOfMany ? "a subagent" : "the subagent"));
}

type ActionFailureIssue = (
  action: string,
  failure: CompactToolActionFailure,
  name: string | undefined,
  oneOfMany: boolean,
) => {
  readonly code: string;
  readonly message: string;
  readonly recovery: { readonly message: string; readonly detail: string };
};

/** Human messages stay short; codes, IDs, and recovery procedures stay expanded-only. */
const ACTION_FAILURE_ISSUES = {
  pending: (_action, _failure, name) => ({
    code: "delivery-pending",
    message: name
      ? `${name}: guidance is awaiting delivery confirmation`
      : pendingDeliveryEvidence.message,
    recovery: {
      message: "Delivery is still being tracked",
      detail: pendingDeliveryEvidence.detail,
    },
  }),
  unconfirmed: (action, _failure, name) => ({
    code: "action-failed",
    message: unconfirmedMessage(action, name),
    recovery: {
      message: "The action may already have taken effect",
      detail: unconfirmedActionRecovery,
    },
  }),
  failed: (action, failure, name, oneOfMany) => ({
    code: "action-failed",
    message: failedActionMessage(action, failure, name, oneOfMany),
    recovery: {
      message: "Recovery details are available",
      detail: failureRecovery(failure.code, failure.message),
    },
  }),
} satisfies Record<ActionFailureDisposition, ActionFailureIssue>;

/** One issue per failed target, plus its expanded-only recovery step. */
export function actionFailureIssues(
  action: string,
  failures: readonly CompactToolActionFailure[],
  cards: readonly SubagentRunCard[],
  summary: CompactSummary,
  issues: CompactIssue[],
): void {
  for (const failure of failures) {
    // Failed targets are usually absent from the visible cards; the detail keeps their identity.
    const name = cards.find((card) => card.id === failure.id)?.name.slice(0, 60);
    const disposition = actionFailureDisposition(action, failure);
    // Pending delivery and unconfirmed outcomes are uncertainty warnings, never failures.
    if (disposition !== "failed") summary.outcome = "uncertain";
    const oneOfMany = failures.length + cards.length > 1;
    const { code, message, recovery } = ACTION_FAILURE_ISSUES[disposition](
      action,
      failure,
      name,
      oneOfMany,
    );
    issues.push(
      {
        severity: disposition === "failed" ? "error" : "warning",
        code: `run:${failure.id}:${code}`,
        message,
        detail: `${failure.id}: ${failure.code ? `[${failure.code}] ` : ""}${failure.message}`,
      },
      { severity: "info", code: `run:${failure.id}:action-recovery`, ...recovery },
    );
  }
}

/**
 * A call the tool rejected before returning a receipt. Pi keeps only its text, so the message
 * is that text when people can read it, or what could not be done.
 */
export function rejectedCallIssue(action: string, text: string, target: string): CompactIssue {
  const readable = readableFailure(text, []);
  // The full text is detail unless the message already says all of it.
  const detail = readable ? quoteText(text, { failure: true }).detail : text.trim() && text;
  return {
    severity: "error",
    code: "call-rejected",
    message: readable ?? couldNot(action, target),
    ...(detail && { detail }),
  };
}
