import type { CompactIssue, CompactSummary } from "pi-code-previews";
import { failureMessage, quoteText } from "pi-cosmic-core";
import type { AgentMessageRefusalCode } from "../run/errors.ts";
import type { CompactToolActionFailure, SubagentRunCard } from "./details-schema.ts";
import {
  actionFailureDisposition,
  isUncertainToolFailure,
  NO_ELIGIBLE_ROUTE_CODES,
  noEligibleRouteRecovery,
  pendingDeliveryEvidence,
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
    ["profile", "candidate", "auth", "harness", "model", "unsupported", "confinement", "readiness"],
    "Inspect the effective route with subagent_models or choose a compatible route in /subagents profiles.",
  ],
  [
    ["capacity", "writer"],
    "Resolve the reported capacity or writer-ownership constraint, then retry the launch.",
  ],
];
const ACTION_FAILURE_RECOVERY_RULES: ReadonlyArray<FailureRecoveryRule> = [
  SCRIPTED_WRITER_RECOVERY,
  [
    ["notfound", "not_found"],
    "Refresh run IDs with subagent_status without runIds.",
    ["not found"],
  ],
  [
    ["completion_claim_conflict"],
    "Wait for or cancel the operation that already owns this completion, then retry.",
  ],
  [
    ["retry_route_exhausted"],
    "The original profile route is exhausted; only now consider a generalist replacement.",
  ],
  [
    ["retry_claim", "retry_already", "resume_superseded"],
    "Inspect the predecessor and its linked successor with subagent_status.",
  ],
  [
    ["report_delivery_backlog"],
    "Wait for automatic outcome delivery or claim the current outcome with subagent_await, then retry.",
  ],
  [
    ["reply_send_failed"],
    "The reply was never delivered and the question is still pending; resend it with subagent_send.",
  ],
  [["reply_too_large"], "The question is still pending; send a shorter reply with subagent_send."],
  [
    ["reply_in_flight"],
    "An earlier reply is still being delivered; await the run or inspect subagent_status before sending again.",
  ],
  [
    ["question_transport_closed"],
    "The helper connection closed and the question was cancelled; inspect subagent_status before taking another action.",
  ],
  [
    ["question_ownership_mismatch"],
    "The question is no longer pending; refresh the run with subagent_status before taking another action.",
  ],
  [
    ["waiting_for_parent", "parent_question"],
    "Answer with subagent_send, then await the run again.",
    ["waiting for a parent reply"],
  ],
  [["capability", "unsupported"], "Inspect the run's capabilities with subagent_status."],
  [
    ["profile", "candidate", "auth", "harness", "model"],
    "Inspect the effective route with subagent_models or edit it with /subagents profiles.",
  ],
];
const UNCERTAIN_FAILURE_RECOVERY_RULES: ReadonlyArray<FailureRecoveryRule> = [
  [
    ["retry_cleanup_unconfirmed", "retry_outcome_uncertain"],
    "Do not retry automatically; inspect the failed run and resolve the reported ownership uncertainty.",
  ],
  [
    ["reply_outcome_uncertain"],
    "Do not resend the reply automatically; inspect subagent_status and wait for the run's next event.",
  ],
];

export const failureRecovery = (
  code: string | undefined,
  message: string,
  context: "start" | "action" = "action",
): string => {
  const normalizedCode = code?.toLowerCase() ?? "";
  const normalizedMessage = message.toLowerCase();
  const [rules, fallback] = isUncertainToolFailure({ code: normalizedCode })
    ? [
        UNCERTAIN_FAILURE_RECOVERY_RULES,
        context === "start"
          ? "Do not retry the launch automatically; it may already have taken effect. List runs and inspect subagent_status before recovery."
          : unconfirmedActionRecovery,
      ]
    : context === "start"
      ? [
          START_FAILURE_RECOVERY_RULES,
          "Review the launch failure and profile route before retrying.",
        ]
      : [
          ACTION_FAILURE_RECOVERY_RULES,
          "Review the failure detail and current subagent_status before retrying.",
        ];
  const matched = rules.find(
    ([codes, , messages]) =>
      codes.some((needle) => normalizedCode.includes(needle)) ||
      messages?.some((needle) => normalizedMessage.includes(needle)),
  );
  return matched?.[1] ?? fallback;
};

type Phrase = (subject: string) => string;

const FAILURE_PHRASES: ReadonlyArray<readonly [ReadonlyArray<string>, Phrase]> = [
  [["notfound", "not_found"], () => "A requested subagent was not found"],
  [["parent_question_missing"], (subject) => `${subject} has no question waiting for a reply`],
  [["question_ownership_mismatch"], (subject) => `${subject}'s question is no longer waiting`],
  [["question_transport_closed"], (subject) => `${subject}'s question was cancelled`],
  [["reply_send_failed"], (subject) => `${subject} didn't receive the reply`],
  [["too_large"], () => "The message is too long"],
  [["retry_route_exhausted"], (subject) => `${subject} has no profile options left to retry`],
  [["retry_claim", "retry_already"], (subject) => `${subject} is already being retried`],
  [["resume_superseded"], (subject) => `${subject} was already replaced by a retry`],
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
  [["lifecycle_message_invalid"], () => "Guidance can only be sent with a resume"],
  [["capacity"], () => "No subagent capacity is left"],
  [["nesting_depth_limit"], () => "The subagent nesting limit was reached"],
];

const VERBS = new Map([
  ["send", "send a message to"],
  ["interrupt", "interrupt"],
  ["resume", "resume"],
  ["stop", "stop"],
  ["retry", "retry"],
  ["status", "find"],
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

const AGENT_TEXT = /\bsubagent_[a-z_]+\b|\b\w+\(\s*\{|\b\w+=["\w]|\bagent-[\w-]+/u;

const readableFailure = (text: string, forbidden: readonly string[]): string | undefined => {
  const line = failureMessage(text, "");
  return line && !AGENT_TEXT.test(line) && !forbidden.some((id) => id && line.includes(id))
    ? line
    : undefined;
};

const NOUNS = new Map([
  ["send", "message"],
  ["interrupt", "interrupt"],
  ["resume", "resume"],
  ["stop", "stop"],
  ["retry", "retry"],
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

export function actionFailureIssues(
  action: string,
  failures: readonly CompactToolActionFailure[],
  cards: readonly SubagentRunCard[],
  summary: CompactSummary,
  issues: CompactIssue[],
): void {
  for (const failure of failures) {
    const name = cards.find((card) => card.id === failure.id)?.name.slice(0, 60);
    const disposition = actionFailureDisposition(action, failure);
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
  const readable = readableFailure(text, []);
  const detail = readable ? quoteText(text, { failure: true }).detail : text.trim() && text;
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
      "Check the agent's state with agent_list. A starting agent accepts messages once it runs; a stopping or removed one never does. Read a finishing run's report with agent_read instead.",
  },
  agent_resume_unsupported: {
    message: (subject) => `${subject} has finished and can't be resumed`,
    recovery:
      "Finished Claude and Codex runs can't be resumed. Start a new agent with the context it needs, or message its parent.",
  },
  agent_rate_limited: {
    message: () => "Too many agent messages were sent; wait before sending again",
    recovery:
      "Each agent may send 10 messages a minute, and 3 in a row to one agent before waiting 5 seconds per message. Wait as long as the error says before sending again, and don't resend in a loop.",
  },
  agent_message_budget_exhausted: {
    message: () => "Agents already sent as many messages as allowed",
    recovery:
      "Until the user's next prompt, each agent may send another agent 20 messages, and the session's agents 200 in all. Finish with what you have, report to your parent, or leave the rest to the user; don't retry.",
  },
  agent_wake_budget_exhausted: {
    message: (subject) => `${subject} was already resumed by messages as often as allowed`,
    recovery:
      "Agent messages may resume each agent 3 times, and the session 12 times, until the user's next prompt. Message an agent that is still running, or leave it to the user.",
  },
  agent_spend_limit: {
    message: (subject) => `${subject} can't be resumed after the session's spend limit`,
    recovery:
      "This session's subagents reached sessionSpendLimit, so agent messages can't resume finished runs. Message an agent that is still running, or leave it to the user.",
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
  Object.entries(AGENT_FAILURES),
);

const CODED_FAILURE = /^\[([a-z][a-z0-9_]*)\] /u;

/**
 * Issues for a rejected `agent_*` call. Its error text starts with the refusal code in brackets;
 * `subject` names the agent the call addressed.
 */
export function agentFailureIssues(text: string, action: string, subject: string): CompactIssue[] {
  const code = CODED_FAILURE.exec(text.trimStart())?.[1];
  const known = code === undefined ? undefined : AGENT_FAILURE_CODES.get(code);
  if (!known) return [rejectedCallIssue(action, text, subject.toLowerCase())];
  return [
    {
      severity: "error",
      code: `agent:${code ?? "failed"}`,
      message: known.message(subject),
      detail: `${text.trim()}\n${known.recovery}`,
    },
  ];
}
