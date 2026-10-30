import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { argumentFailureIssue, type CompactIssue, type CompactSummary } from "pi-code-previews";
import { failureMessage, quoteText } from "pi-cosmic-core/message-text";
import type { AgentMessageRefusalCode } from "../run/errors.ts";
import type { CompactToolActionFailure, SubagentRunCard } from "./details-schema.ts";
import { CODED_FAILURE, type RejectedFailure } from "./failure-details.ts";
import { actionFailureDisposition, isUncertainToolFailure } from "./outcome.ts";

type Phrase = (subject: string) => string;

const FAILURE_PHRASES: ReadonlyArray<readonly [ReadonlyArray<string>, Phrase]> = [
  [["caller_not_registered"], () => "The calling agent is no longer registered"],
  [["notfound", "not_found"], () => "A requested subagent was not found"],
  [["parent_question_missing"], (subject) => `${subject} has no question waiting for a reply`],
  [["question_ownership_mismatch"], (subject) => `${subject}'s question is no longer waiting`],
  [["question_transport_closed"], (subject) => `${subject}'s question was cancelled`],
  [["reply_send_failed"], (subject) => `${subject} didn't receive the reply`],
  [["completion_claim_conflict"], (subject) => `${subject}'s outcome is claimed by another wait`],
  [
    ["report_delivery_backlog"],
    (subject) => `${subject}'s earlier outcome is still being delivered`,
  ],
  [["not_running"], (subject) => `${subject} isn't running`],
  [["run_starting"], (subject) => `${subject} is still starting`],
  [["reply_in_flight"], (subject) => `${subject} is still receiving an earlier reply`],
  [["in_flight"], (subject) => `${subject} is already handling a request`],
  [["state_invalid", "state_reclaimed"], (subject) => `${subject} can't do that right now`],
  [["resume_unavailable"], (subject) => `${subject} can't be resumed`],
  [["capacity"], () => "No subagent capacity is left"],
  [["nesting_depth_limit"], () => "The subagent nesting limit was reached"],
];

const VERBS = new Map([
  ["send", "send a message to"],
  ["read", "read"],
  ["interrupt", "interrupt"],
  ["stop", "stop"],
  ["list", "list"],
  ["await", "wait for"],
  ["start", "start"],
  ["models", "inspect"],
  ["review", "review"],
  ["prepare", "prepare"],
  ["revise", "request a revision of"],
  ["discard", "discard"],
  ["progress", "send progress to"],
  ["warning", "send the warning to"],
  ["question", "ask"],
]);

const AGENT_TEXT = /\bagent_[a-z_]+\b|\b\w+\(\s*\{|\b\w+=["\w]|\bagent-[\w-]+/u;

const readableFailure = (text: string, forbidden: readonly string[]): string | undefined => {
  const line = failureMessage(text, "");
  return line &&
    !AGENT_TEXT.test(line) &&
    !Arr.some(forbidden, (id) => id !== "" && Fn.pipe(line, Str.includes(id)))
    ? line
    : undefined;
};

const NOUNS = new Map([
  ["send", "message"],
  ["interrupt", "interrupt"],
  ["stop", "stop"],
]);

const unconfirmedMessage = (action: string, name: string | undefined): string => {
  const noun = NOUNS.get(action) ?? "action";
  return name ? `${name}: the ${noun} couldn't be confirmed` : `The ${noun} couldn't be confirmed`;
};

const couldNot = (action: string, target: string): string =>
  `Couldn't ${VERBS.get(action) ?? action} ${target}`;

function failedActionMessage(
  action: string,
  failure: Pick<CompactToolActionFailure, "id" | "code" | "message">,
  name: string | undefined,
  oneOfMany = false,
): string {
  const code = failure.code === undefined ? "" : Str.toLowerCase(failure.code);
  const phrase = Option.getOrUndefined(
    Arr.findFirst(FAILURE_PHRASES, ([codes]) =>
      Arr.some(codes, (needle) => Fn.pipe(code, Str.includes(needle))),
    ),
  );
  if (phrase) return phrase[1](name ?? (oneOfMany ? "A subagent" : "The subagent"));
  const readable = readableFailure(failure.message, [failure.id]);
  if (readable) return name ? `${name}: ${readable}` : readable;
  return couldNot(action, name ?? (oneOfMany ? "a subagent" : "the subagent"));
}

export function actionFailureIssues(
  action: string,
  failures: readonly CompactToolActionFailure[],
  cards: readonly SubagentRunCard[],
  summary: CompactSummary,
  issues: CompactIssue[],
): void {
  for (const failure of failures) {
    const name = Fn.pipe(
      Arr.findFirst(cards, (card) => card.id === failure.id),
      Option.map((card) => Fn.pipe(card.name, Str.slice(0, 60))),
      Option.getOrUndefined,
    );
    const disposition = actionFailureDisposition(failure);
    if (disposition !== "failed") summary.outcome = "uncertain";
    const oneOfMany = failures.length + cards.length > 1;
    issues.push({
      severity: disposition === "failed" ? "error" : "warning",
      code: `run:${failure.id}:action-failed`,
      message:
        disposition === "failed"
          ? failedActionMessage(action, failure, name, oneOfMany)
          : unconfirmedMessage(action, name),
      // The target's ID and the failure's code are among the result's details.
      detail: failure.message,
    });
  }
}

export function rejectedCallIssue(action: string, text: string, target: string): CompactIssue {
  // Pi's own rejection names the tool, which `readableFailure` would refuse as agent text.
  const invalid = argumentFailureIssue(text);
  if (invalid) return invalid;
  const readable = readableFailure(text, []);
  const detail = readable ? quoteText(text, { failure: true }).detail : Str.trim(text) && text;
  return {
    severity: "error",
    code: "call-rejected",
    message: readable ?? couldNot(action, target),
    ...(detail && { detail }),
  };
}

/** Failures of `agent_*` calls: the service's refusals plus request validation. */
type AgentFailureCode =
  | AgentMessageRefusalCode
  | "too_many_targets"
  | "agent_ids_required"
  | "scripted_agent_send_not_supported"
  | "message_required"
  | "message_too_large";

interface AgentFailurePresentation {
  readonly message: (subject: string) => string;
}

const AGENT_FAILURES = {
  agent_self_target: { message: () => "An agent can't message itself" },
  agent_not_found: { message: (subject) => `${subject} isn't in this session` },
  agent_unavailable: { message: (subject) => `${subject} can't receive messages right now` },
  too_many_targets: { message: () => "Too many agents were named" },
  agent_ids_required: { message: () => "No agent was named" },
  scripted_agent_send_not_supported: { message: () => "Scripts can't send agent messages" },
  message_required: { message: () => "The message is empty" },
  message_too_large: { message: () => "The message is too long" },
} satisfies Record<AgentFailureCode, AgentFailurePresentation>;

const AGENT_FAILURE_CODES: ReadonlyMap<string, AgentFailurePresentation> = new Map(
  Rec.toEntries(AGENT_FAILURES),
);

/**
 * The issue for a rejected run action with a code, phrased from the code so the IDs its failure
 * names stay in the detail. `subject` names the addressed run.
 */
export function codedActionFailureIssue(
  failure: RejectedFailure,
  action: string,
  subject: { readonly name?: string; readonly oneOfMany?: boolean },
): CompactIssue | undefined {
  const code = failure.code;
  if (code === undefined) return undefined;
  const uncertain = isUncertainToolFailure({ code });
  const message = Fn.pipe(failure.message, Str.trimStart, Str.replace(CODED_FAILURE, ""));
  return {
    severity: uncertain ? "warning" : "error",
    code: `agent:${code}`,
    message: uncertain
      ? unconfirmedMessage(action, undefined)
      : failedActionMessage(action, { id: "", code, message }, subject.name, subject.oneOfMany),
    detail: failure.message,
  };
}

/** Issues for a rejected `agent_*` call; `subject` names the agent the call addressed. */
export function agentFailureIssues(
  failure: RejectedFailure,
  action: string,
  subject: string,
): CompactIssue[] {
  const code = failure.code;
  const known = code === undefined ? undefined : AGENT_FAILURE_CODES.get(code);
  // A message to a run can also fail delivery, with the same codes and recovery as other actions.
  const delivery = known ? undefined : codedActionFailureIssue(failure, action, { name: subject });
  if (delivery) return [delivery];
  if (!known) return [rejectedCallIssue(action, failure.message, Str.toLowerCase(subject))];
  return [
    {
      severity: "error",
      code: `agent:${code ?? "failed"}`,
      message: known.message(subject),
      detail: failure.message,
    },
  ];
}
