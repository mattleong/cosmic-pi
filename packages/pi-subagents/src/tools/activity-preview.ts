import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { clipText, countLabel, formatTokens } from "pi-cosmic-core/display";
import { failureMessage } from "pi-cosmic-core/message-text";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import {
  SUBAGENT_RUN_STATES,
  type SubagentToolActivity,
  type SubagentToolActivityFact,
} from "../run/model.ts";
import {
  AGENT_TOOL_NAMES,
  CONTACT_PARENT_TOOL_NAME,
  SUBAGENT_TOOL_NAMES,
} from "../run/tool-policy.ts";
import { savedFileFact } from "../ui/notice-facts.ts";
import { displayName } from "../ui/notice-details.ts";
import { projectRunRoutePresentation } from "../ui/run-presentation.ts";
import { runStateLabel } from "../ui/run-state.ts";
import { decodeAgentToolDetails } from "./compact-agent-summary.ts";
import { decodeOutcomeDetails } from "./details-decode.ts";
import { CODED_FAILURE } from "./failure-details.ts";
import {
  ToolFailureDetailsSchema,
  type AgentToolDetails,
  type CompactSubagentToolDetails,
  type SubagentAwaitDetails,
  type SubagentRunCard,
  type SubagentStartDetails,
} from "./details-schema.ts";
import { sendStatus } from "./render-agents.ts";
import { isTextFragment } from "./text-fragments.ts";

const MAX_NAMES = 4;
const MAX_FACTS = 8;
const MAX_TEXT_CHARS = 1_200;
const MAX_LINE_CHARS = 240;

const OWNED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...SUBAGENT_TOOL_NAMES,
  ...AGENT_TOOL_NAMES,
  CONTACT_PARENT_TOOL_NAME,
]);

/** Tools whose model-facing results are delivery envelopes rather than output a user reads. */
export const isOwnedAgentTool = (toolName: string): boolean => OWNED_TOOL_NAMES.has(toolName);

const ToolResultSchema = Schema.Struct({
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
  details: Schema.optional(Schema.Unknown),
});
/** A finished tool call's result as Pi reports it: content parts and its display details. */
export type AgentToolResult = typeof ToolResultSchema.Type;
export const decodeAgentToolResult = decodeUnknownOrUndefined(ToolResultSchema);
const decodeFailureDetails = decodeUnknownOrUndefined(ToolFailureDetailsSchema);
const TextPartSchema = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const isTextPart = Schema.is(TextPartSchema);

const resultText = (content: AgentToolResult["content"]): string =>
  content === undefined
    ? ""
    : Predicate.isString(content)
      ? content
      : Arr.join(
          Arr.flatMap(content, (part) => (isTextPart(part) ? [part.text] : [])),
          "\n",
        );

const line = (text: string): string => clipText(sanitizeTerminalLine(text), MAX_LINE_CHARS);
const name = displayName;

// A rejection's first line, without its bracketed code, as the user reads it.
const failureLine = (text: string): string =>
  failureMessage(
    Fn.pipe(Str.trimStart(text), Str.replace(CODED_FAILURE, "")),
    "failed",
    MAX_LINE_CHARS,
  );

/** Up to a few names, then how many more: `A, B, C, D and 2 more`. */
const names = (all: ReadonlyArray<string>): string => {
  const shown = Arr.join(all.slice(0, MAX_NAMES), ", ");
  return all.length > MAX_NAMES ? `${shown} and ${all.length - MAX_NAMES} more` : shown;
};

const fact = (label: string, value: string): SubagentToolActivityFact => ({
  label,
  value: line(value),
});

const route = (card: {
  readonly profile?: string | undefined;
  readonly model: string;
  readonly effort: string;
  readonly openaiFastMode?: boolean | undefined;
  readonly modelOverride?: object | undefined;
}): string => projectRunRoutePresentation(card).model;

const activity = (
  summary: string,
  text: string | undefined,
  facts: ReadonlyArray<SubagentToolActivityFact>,
): SubagentToolActivity => {
  const words = text === undefined ? "" : Str.trim(text);
  return {
    summary: line(summary),
    ...(words && { text: clipText(words, MAX_TEXT_CHARS) }),
    ...(facts.length > 0 && { facts: facts.slice(0, MAX_FACTS) }),
  };
};

const startActivity = (details: SubagentStartDetails): SubagentToolActivity => {
  const started = Arr.flatMap(details.startEntries, (entry) =>
    entry.status === "started" ? [entry] : [],
  );
  const failures = details.startFailures ?? [];
  const failedName = (failure: (typeof failures)[number]): string =>
    name(failure.name ?? `Launch ${failure.index + 1}`);
  const [onlyFailure] = failures;
  const failedPart =
    failures.length === 0
      ? undefined
      : failures.length === 1 && onlyFailure
        ? `${failedName(onlyFailure)} couldn't start: ${failureLine(onlyFailure.message)}`
        : `${names(Arr.map(failures, failedName))} couldn't start`;
  const startedPart =
    started.length === 0
      ? undefined
      : `started ${names(Arr.map(started, (entry) => `${name(entry.name)} (${name(entry.agent ?? entry.profile)})`))}`;
  return activity(
    Arr.join(Arr.filter([startedPart, failedPart], isTextFragment), " · ") || "started nothing",
    failures.length > 1
      ? Arr.join(
          Arr.map(
            failures,
            (failure) => `- ${failedName(failure)}: ${failureLine(failure.message)}`,
          ),
          "\n",
        )
      : undefined,
    [
      ...Arr.map(started, (entry) =>
        fact("Started", `${entry.runId} · ${entry.name} · ${route(entry)}`),
      ),
      ...Arr.flatMap(failures, (failure) =>
        failure.admittedRun?.failureFile
          ? [
              fact(
                "Failure file",
                savedFileFact(failedName(failure), failure.admittedRun.failureFile),
              ),
            ]
          : [],
      ),
    ],
  );
};

const cardPhrase = (card: SubagentRunCard): string =>
  card.state === "waiting_for_parent"
    ? `${name(card.name)} asked a question`
    : `${name(card.name)} ${runStateLabel(card.state)}`;

/** The words a card returned: its report, its question, or its failure. */
const cardWords = (card: SubagentRunCard): string | undefined =>
  card.state === "waiting_for_parent" && card.question
    ? card.question.message
    : (card.finalText ?? (card.error === undefined ? undefined : failureLine(card.error)));

const awaitEnding = (details: SubagentAwaitDetails): string | undefined => {
  if (details.agentMessages?.endedWait)
    return `stopped waiting to read ${details.agentMessages.count === 1 ? "a message" : countLabel(details.agentMessages.count, "message")}`;
  if (!details.cancelled) return undefined;
  if (details.endedByUserInput) return "stopped waiting to read a new message";
  if (details.timedOutSeconds !== undefined)
    return `stopped waiting after ${details.timedOutSeconds}s`;
  return "stopped waiting";
};

const awaitActivity = (details: SubagentAwaitDetails): SubagentToolActivity => {
  const awaitedIds =
    details.awaitedRunIds === undefined ? undefined : new Set(details.awaitedRunIds);
  const cards = awaitedIds
    ? Arr.filter(details.cards, (card) => awaitedIds.has(card.id))
    : details.cards;
  const tokens = Arr.reduce(cards, 0, (total, card) => total + card.usage.totalTokens);
  const phrases = Arr.map(cards, cardPhrase);
  const summary = Arr.join(
    Arr.filter(
      [
        awaitEnding(details),
        phrases.length > MAX_NAMES
          ? `${phrases.length} subagents: ${Arr.join(phrases.slice(0, MAX_NAMES), ", ")} and ${phrases.length - MAX_NAMES} more`
          : Arr.join(phrases, ", "),
        tokens > 0 ? `${formatTokens(tokens)} tokens` : undefined,
      ],
      isTextFragment,
    ),
    " · ",
  );
  const [only] = cards;
  const words =
    cards.length === 1 && only
      ? cardWords(only)
      : Arr.join(
          Arr.flatMap(cards, (card) => {
            const said = cardWords(card);
            return said === undefined ? [] : [`**${name(card.name)}**\n\n${said}`];
          }),
          "\n\n",
        );
  return activity(summary || "waited", words, [
    ...Arr.map(cards, (card) => fact("Awaited", `${card.id} · ${card.name} · ${route(card)}`)),
    ...Arr.flatMap(cards, (card) =>
      card.reportArchive
        ? [fact("Report file", savedFileFact(name(card.name), card.reportArchive))]
        : [],
    ),
  ]);
};

const LIFECYCLE_VERBS = { interrupt: "interrupted", stop: "stopped" } as const;
const LIFECYCLE_FAILURES = { interrupt: "couldn't interrupt", stop: "couldn't stop" } as const;

const compactActivity = (details: CompactSubagentToolDetails): SubagentToolActivity => {
  if (details.action === "models")
    return activity(
      Arr.join(
        Arr.filter(
          [
            `listed ${countLabel(details.profiles.length, "profile")}`,
            details.agents?.length ? countLabel(details.agents.length, "agent") : undefined,
          ],
          isTextFragment,
        ),
        " · ",
      ),
      undefined,
      [],
    );
  const failedIds = new Set(Arr.map(details.actionFailures ?? [], (failure) => failure.id));
  const done = Arr.filter(details.cards, (card) => !failedIds.has(card.id));
  const failed = Arr.filter(details.cards, (card) => failedIds.has(card.id));
  const [onlyFailure] = details.actionFailures ?? [];
  return activity(
    Arr.join(
      Arr.filter(
        [
          done.length > 0
            ? `${LIFECYCLE_VERBS[details.action]} ${names(Arr.map(done, (card) => name(card.name)))}`
            : undefined,
          failed.length > 0
            ? `${LIFECYCLE_FAILURES[details.action]} ${names(Arr.map(failed, (card) => name(card.name)))}${
                failed.length === 1 && onlyFailure ? `: ${failureLine(onlyFailure.message)}` : ""
              }`
            : undefined,
        ],
        isTextFragment,
      ),
      " · ",
    ) || `${LIFECYCLE_VERBS[details.action]} nothing`,
    undefined,
    Arr.map(details.cards, (card) => fact("Target", `${card.id} · ${card.name}`)),
  );
};

const agentStateLabel = (state: string): string =>
  Option.match(
    Arr.findFirst(SUBAGENT_RUN_STATES, (known) => known === state),
    { onNone: () => state, onSome: runStateLabel },
  );

const SEND_VERBS = { answered: "answered", guided: "sent to", resumed: "resumed" } as const;

const agentActivity = (details: AgentToolDetails): SubagentToolActivity => {
  switch (details.action) {
    case "agent_list": {
      const states = Arr.map(
        details.states,
        ({ state, count }) => `${count} ${agentStateLabel(state)}`,
      );
      return activity(
        Arr.join(
          [
            countLabel(details.agentCount, "agent"),
            ...(states.length > 1 ? [Arr.join(states, ", ")] : []),
          ],
          " · ",
        ),
        undefined,
        [],
      );
    }
    case "agent_send":
      return activity(
        Arr.join(
          Arr.filter(
            [`${SEND_VERBS[details.disposition]} ${name(details.name)}`, sendStatus(details)],
            isTextFragment,
          ),
          " · ",
        ),
        undefined,
        [fact("To", details.to)],
      );
    case "agent_read": {
      const [only] = details.agents;
      return activity(
        `read ${names(Arr.map(details.agents, (agent) => name(agent.name)))}`,
        details.agents.length === 1 && only ? only.text : undefined,
        Arr.flatMap(details.agents, (agent) =>
          Arr.map(agent.facts ?? [], (value) => fact(name(agent.name), value)),
        ),
      );
    }
  }
  return Fn.absurd(details);
};

const PARENT_REPLY = "Parent reply: ";

/**
 * Phrases an owned agent tool's result from the display details its producer wrote, never from
 * the model-facing envelope: IDs, routes, and report files become technical facts. Undefined for
 * other tools, whose output is shown as printed.
 */
export const agentToolActivity = (
  toolName: string,
  decoded: AgentToolResult | undefined,
  isError: boolean,
): SubagentToolActivity | undefined => {
  if (!isOwnedAgentTool(toolName)) return undefined;
  const text = resultText(decoded?.content);
  const failure = decodeFailureDetails(decoded?.details);
  if (failure) return activity(failureLine(failure.message), undefined, []);
  if (toolName === CONTACT_PARENT_TOOL_NAME)
    return isError
      ? activity(failureLine(text), undefined, [])
      : activity(Str.startsWith(PARENT_REPLY)(text) ? "answered" : "delivered", undefined, []);
  const outcome = decodeOutcomeDetails(decoded?.details);
  if (outcome?.action === "start") return startActivity(outcome);
  if (outcome?.action === "await") return awaitActivity(outcome);
  if (outcome) return compactActivity(outcome);
  const agent = decodeAgentToolDetails(decoded?.details);
  if (agent) return agentActivity(agent);
  // A result without details is a rejection whose text is all there is; its first line says why.
  return isError ? activity(failureLine(text), undefined, []) : undefined;
};
