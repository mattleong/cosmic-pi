import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { argumentFailureIssue, type CompactIssue, type CompactSummary } from "pi-code-previews";
import { failureMessage, quoteText } from "pi-cosmic-core/message-text";
import type { AgentMessageRefusalCode } from "../run/errors.ts";
import type { CompactToolActionFailure, SubagentRunCard } from "./details-schema.ts";
import {
  actionFailureDisposition,
  isUncertainToolFailure,
  NO_ELIGIBLE_ROUTE_CODES,
  noEligibleRouteRecovery,
  unconfirmedActionRecovery,
  type ActionFailureDisposition,
} from "./outcome.ts";

type FailureRecoveryRule = readonly [
  codes: ReadonlyArray<string>,
  recovery: string,
  messages?: ReadonlyArray<string>,
];

const SCRIPTED_WRITER_RECOVERY: FailureRecoveryRule = [
  ["scripted_subtree_writer_not_supported", "scripted_writer_not_supported"],
  "Hand writer work back to the root main agent for authorization and a separate launch outside the script-origin tree.",
];
const START_FAILURE_RECOVERY_RULES: ReadonlyArray<FailureRecoveryRule> = [
  SCRIPTED_WRITER_RECOVERY,
  [
    ["workspace_nested_writer_unsupported"],
    "Ask the root to launch this writer in a worktree, or start a writer that shares your directory.",
  ],
  [["node_executable"], "Restart Pi so it runs on the installed Node, then retry the launch."],
  [NO_ELIGIBLE_ROUTE_CODES, noEligibleRouteRecovery],
  [
    ["model_override"],
    "Fix the model override, or omit it to use the profile's route; an override never falls back.",
  ],
  [
    ["pi_model_not_found"],
    "Install the extension that provides the model with pi install, or choose another route in /subagents profiles.",
  ],
  [
    ["profile", "candidate", "auth", "model", "unsupported", "readiness"],
    "Inspect the effective route with agent_profiles or choose a compatible route in /subagents profiles.",
  ],
  [
    ["capacity", "writer"],
    "Resolve the reported capacity or writer-ownership constraint, then retry the launch.",
  ],
];
const ACTION_FAILURE_RECOVERY_RULES: ReadonlyArray<FailureRecoveryRule> = [
  SCRIPTED_WRITER_RECOVERY,
  [
    ["caller_not_registered"],
    "This run was removed from the session, so it can't act on other agents; finish with your final report.",
  ],
  [["notfound", "not_found"], "Refresh run IDs with agent_list.", ["not found"]],
  [
    ["completion_claim_conflict"],
    "Wait for or cancel the operation that already owns this completion, then retry.",
  ],
  [
    ["report_delivery_backlog"],
    "Wait for automatic outcome delivery or claim the current outcome with agent_await, then retry.",
  ],
  [
    ["reply_send_failed"],
    "The reply was never delivered and the question is still pending; resend it with agent_send.",
  ],
  [
    ["reply_in_flight"],
    "An earlier reply is still being delivered; await the run or inspect it with agent_read before sending again.",
  ],
  [
    ["question_transport_closed"],
    "The helper connection closed and the question was cancelled; inspect the run with agent_read before taking another action.",
  ],
  [
    ["question_ownership_mismatch"],
    "The question is no longer pending; refresh the run with agent_read before taking another action.",
  ],
  [
    ["waiting_for_parent", "parent_question"],
    "Answer with agent_send, then await the run again.",
    ["waiting for a parent reply"],
  ],
  [
    ["interrupt_in_flight"],
    "An interrupt is still pending; await the run, then send again once it pauses or runs.",
  ],
  [["capability", "unsupported"], "Inspect the run's capabilities with agent_read."],
  [
    ["profile", "candidate", "auth", "model"],
    "Inspect the effective route with agent_profiles or edit it with /subagents profiles.",
  ],
];
const UNCERTAIN_FAILURE_RECOVERY_RULES: ReadonlyArray<FailureRecoveryRule> = [
  [
    ["reply_outcome_uncertain"],
    "Do not resend the reply automatically; inspect the run with agent_read and wait for its next event.",
  ],
  [
    ["guidance_outcome_uncertain"],
    "The guidance may already have arrived; do not resend it. Inspect the run with agent_read and wait for its next event.",
  ],
];

export const failureRecovery = (
  code: string | undefined,
  message: string,
  context: "start" | "action" = "action",
): string => {
  const normalizedCode = code === undefined ? "" : Str.toLowerCase(code);
  const normalizedMessage = Str.toLowerCase(message);
  const [rules, fallback] = isUncertainToolFailure({ code: normalizedCode })
    ? [
        UNCERTAIN_FAILURE_RECOVERY_RULES,
        context === "start"
          ? "Do not retry the launch automatically; it may already have taken effect. List runs with agent_list and inspect them with agent_read before recovery."
          : unconfirmedActionRecovery,
      ]
    : context === "start"
      ? [
          START_FAILURE_RECOVERY_RULES,
          "Review the launch failure and profile route before retrying.",
        ]
      : [
          ACTION_FAILURE_RECOVERY_RULES,
          "Review the failure detail and the run's current state with agent_read before retrying.",
        ];
  // An exact code wins over a rule whose broader code fragment it happens to contain.
  return Fn.pipe(
    Arr.findFirst(rules, ([codes]) => codes.includes(normalizedCode)),
    Option.orElse(() =>
      Arr.findFirst(
        rules,
        ([codes, , messages]) =>
          Arr.some(codes, (needle) => Fn.pipe(normalizedCode, Str.includes(needle))) ||
          (messages !== undefined &&
            Arr.some(messages, (needle) => Fn.pipe(normalizedMessage, Str.includes(needle)))),
      ),
    ),
    Option.match({ onNone: () => fallback, onSome: ([, recovery]) => recovery }),
  );
};

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

const ACTION_FAILURE_ISSUES = {
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
  readonly recovery: string;
}

const AGENT_FAILURES = {
  agent_self_target: {
    message: () => "An agent can't message itself",
    recovery: "Name another agent from agent_list, or main.",
  },
  agent_not_found: {
    message: (subject) => `${subject} isn't in this session`,
    recovery:
      "Refresh agent IDs with agent_list; runs removed from the session can't receive messages.",
  },
  agent_unavailable: {
    message: (subject) => `${subject} can't receive messages right now`,
    recovery:
      "Check the agent's state with agent_list. A starting agent accepts messages once it runs. A stopping Pi agent, or one inside a subtree being stopped, can be resumed with a message once the stop finishes. A removed agent can't receive messages.",
  },
  agent_resume_unsupported: {
    message: (subject) => `${subject} can't be resumed`,
    recovery:
      "Stop a paused one with agent_lifecycle and start a replacement; for a finished one, start a new agent with the context it needs, or message its parent.",
  },
  too_many_targets: {
    message: () => "Too many agents were named",
    recovery: "Name at most 12 agents, or call agent_list without agentIds.",
  },
  agent_ids_required: {
    message: () => "No agent was named",
    recovery: "Name at least one agent ID from agent_list, or main.",
  },
  scripted_agent_send_not_supported: {
    message: () => "Scripts can't send agent messages",
    recovery: "End the script and send the message with agent_send directly.",
  },
  message_required: {
    message: () => "The message is empty",
    recovery: "Send a nonblank, self-contained message.",
  },
  message_too_large: {
    message: () => "The message is too long",
    recovery: "Shorten the message to at most 16,384 characters.",
  },
} satisfies Record<AgentFailureCode, AgentFailurePresentation>;

const AGENT_FAILURE_CODES: ReadonlyMap<string, AgentFailurePresentation> = new Map(
  Rec.toEntries(AGENT_FAILURES),
);

const CODED_FAILURE = /^\[([a-z][a-z0-9_]*)\] /u;

/**
 * The issue for a rejected run action whose error text starts with its code in brackets, phrased
 * from the code so the IDs the text names stay in the detail. `subject` names the addressed run.
 */
export function codedActionFailureIssue(
  text: string,
  action: string,
  subject: { readonly name?: string; readonly oneOfMany?: boolean },
): CompactIssue | undefined {
  const code = CODED_FAILURE.exec(Str.trimStart(text))?.[1];
  if (code === undefined) return undefined;
  const uncertain = isUncertainToolFailure({ code });
  const message = Fn.pipe(text, Str.trimStart, Str.replace(CODED_FAILURE, ""));
  return {
    severity: uncertain ? "warning" : "error",
    code: `agent:${code}`,
    message: uncertain
      ? unconfirmedMessage(action, undefined)
      : failedActionMessage(action, { id: "", code, message }, subject.name, subject.oneOfMany),
    detail: `${Str.trim(text)}\n${failureRecovery(code, message)}`,
  };
}

/**
 * Issues for a rejected `agent_*` call. Its error text starts with the refusal code in brackets;
 * `subject` names the agent the call addressed.
 */
export function agentFailureIssues(text: string, action: string, subject: string): CompactIssue[] {
  const code = CODED_FAILURE.exec(Str.trimStart(text))?.[1];
  const known = code === undefined ? undefined : AGENT_FAILURE_CODES.get(code);
  // A message to a run can also fail delivery, with the same codes and recovery as other actions.
  const delivery = known ? undefined : codedActionFailureIssue(text, action, { name: subject });
  if (delivery) return [delivery];
  if (!known) return [rejectedCallIssue(action, text, Str.toLowerCase(subject))];
  return [
    {
      severity: "error",
      code: `agent:${code ?? "failed"}`,
      message: known.message(subject),
      detail: `${Str.trim(text)}\n${known.recovery}`,
    },
  ];
}
