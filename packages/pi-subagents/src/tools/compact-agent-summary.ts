import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import {
  compactIssueSeverity,
  type CompactIssue,
  type CompactSummary,
  type CompactSummaryProvider,
} from "pi-code-previews";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { countLabel } from "pi-cosmic-core/display";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import { MAIN_AGENT_ID } from "../run/agent-messaging.ts";
import { SUBAGENT_RUN_STATES } from "../run/model.ts";
import { AGENT_TOOL_NAME, type AgentToolName } from "../run/tool-policy.ts";
import { displayName } from "../ui/notice-details.ts";
import { runStateLabel } from "../ui/run-state.ts";
import { agentFailureIssues } from "./compact-action-failures.ts";
import { quotesPartOfQuestion } from "./compact-run-issues.ts";
import { rejectedFailure } from "./failure-details.ts";
import { sendStatus } from "./render-agents.ts";
import { AgentToolDetailsSchema, type AgentToolDetails } from "./details-schema.ts";

export const decodeAgentToolDetails = decodeUnknownOrUndefined(AgentToolDetailsSchema, {
  onExcessProperty: "error",
});

// What a call's arguments show before the tool validated them, for headings and failures.
const AgentCallSchema = Schema.Struct({
  to: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  agentIds: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type AgentCallEvidence = typeof AgentCallSchema.Type;
export const decodeAgentCall = decodeUnknownOrUndefined(AgentCallSchema);

const stateLabel = (state: string): string => {
  const runState = Option.getOrUndefined(
    Arr.findFirst(SUBAGENT_RUN_STATES, (known) => known === state),
  );
  return runState === undefined ? state : runStateLabel(runState);
};

// Before a result names a run, only the main agent has a readable subject.
const isMain = (id: string | undefined): boolean =>
  id !== undefined && Str.trim(id) === MAIN_AGENT_ID;

const requestedIds = (args: AgentCallEvidence): ReadonlyArray<string> =>
  Fn.pipe(
    args.agentIds ?? [],
    Arr.map((id) => Str.trim(id)),
    Arr.filter(Boolean),
  );

const missingIssue = (missingIds: ReadonlyArray<string>): CompactIssue[] =>
  missingIds.length === 0
    ? []
    : [
        {
          severity: "warning",
          code: "agents-missing",
          message:
            missingIds.length === 1
              ? "A requested agent isn't in this session"
              : `${missingIds.length} requested agents aren't in this session`,
          detail: `Not found: ${Arr.join(missingIds, ", ")}`,
        },
      ];

/**
 * A settled call's outcome from its issues: a call that changed something succeeded, and one that
 * only looked returned neutrally, unless it raised a problem or something waits on a reply.
 */
const settled = (
  summary: CompactSummary,
  issues: CompactIssue[],
  routine: "success" | "returned" = "success",
): CompactSummary => {
  const severity = compactIssueSeverity(issues);
  return {
    ...summary,
    outcome: severity === "warning" || severity === "attention" ? severity : routine,
    issues,
  };
};

const summarizeList = (
  details: Extract<AgentToolDetails, { readonly action: "agent_list" }>,
): CompactSummary => {
  const states = Arr.map(details.states, ({ state, count }) =>
    details.agentCount === 1 ? stateLabel(state) : `${count} ${stateLabel(state)}`,
  );
  const waiting = Arr.some(details.states, ({ state }) => state === "waiting_for_parent");
  const agents = countLabel(details.agentCount, "agent");
  // One combined counter: how many, then how many in each state when they differ.
  const counters =
    details.agentCount === 0
      ? ["no agents"]
      : details.only
        ? states
        : states.length > 1
          ? [`${agents} · ${Arr.join(states, " · ")}`, agents]
          : [agents];
  const summary = settled(
    {
      subject: details.only ? displayName(details.only.name) : "",
      // One agent's state describes the agent, which the listing's own glyph doesn't say.
      ...(details.only && { subjectState: true as const }),
      counters,
      // An empty listing says so in its heading, so expanding it would show nothing more.
      expandLabel:
        details.agentCount === 0 && details.missingIds.length === 0
          ? false
          : details.agentCount === 1
            ? "agent"
            : "agents",
    },
    missingIssue(details.missingIds),
    "returned",
  );
  // An agent waiting on its parent's reply is a decision someone owes; the list rows show who.
  return waiting && summary.outcome === "returned" ? { ...summary, outcome: "attention" } : summary;
};

type SendDetails = Extract<AgentToolDetails, { readonly action: "agent_send" }>;

const sendIssues = (details: SendDetails): CompactIssue[] =>
  details.mainState === "held"
    ? [
        {
          severity: "info",
          code: "agent-message-held",
          message: "The main agent needs your input first",
          detail:
            "The message is in the main agent's conversation. It reaches the model when an open dialog closes, or after an interrupt, on the user's next prompt.",
        },
      ]
    : [];

const summarizeSend = (details: SendDetails): CompactSummary => {
  const status = sendStatus(details);
  return settled(
    {
      subject: details.to === MAIN_AGENT_ID ? "main" : displayName(details.name),
      counters: status === undefined ? [] : [status],
      messageIcon: "sent",
      // Expansion explains a departure from plain delivery and names a recipient that isn't main.
      ...(status === undefined && details.to === details.name && { expandLabel: false }),
    },
    sendIssues(details),
  );
};

// A few short names read as a list in the heading; more leave it to the counter.
const MAX_NAMED_AGENTS = 3;
const MAX_NAMED_AGENT_CHARS = 48;

type ReadAgent = Extract<AgentToolDetails, { readonly action: "agent_read" }>["agents"][number];

/** What reading an agent shows of it, as a tag names it: `report`, `error`, `question`. */
const readNoun = (agent: ReadAgent): string => {
  if (agent.textStatus === "none" && agent.source !== "report") return "details";
  switch (agent.source) {
    case "report":
      return "report";
    case "error":
      return "error";
    case "question":
      return "question";
    case "assistant":
    case undefined:
      return "message";
  }
  return Fn.absurd(agent.source);
};

/**
 * What expanding a read reveals: each agent's words, named for what they are, or a question its
 * `asks:` line only begins. A whole question is that line, so expansion adds only `Details`.
 */
const readExpandLabel = (agents: ReadonlyArray<ReadAgent>): string => {
  const nouns = Arr.dedupe(
    Arr.map(agents, (agent) =>
      agent.source === "question" && !(agent.text !== undefined && quotesPartOfQuestion(agent.text))
        ? "details"
        : readNoun(agent),
    ),
  );
  const [noun] = nouns;
  if (noun === undefined) return "details";
  if (agents.length === 1) return noun;
  if (nouns.length > 1) return "messages";
  return noun === "details" ? noun : `${noun}s`;
};

const summarizeRead = (
  details: Extract<AgentToolDetails, { readonly action: "agent_read" }>,
): CompactSummary => {
  const [only] = details.agents;
  const single = details.agents.length === 1 && only !== undefined;
  // A saved report's readout carries its file, not text.
  const empty = Arr.filter(
    details.agents,
    (agent) => agent.textStatus === "none" && agent.source !== "report",
  ).length;
  const truncated = Arr.filter(details.agents, (agent) => agent.truncated).length;
  // Each run's status raises its own issues: a question waits on a reply, and the rest describe
  // the run, not the read, so they show expanded.
  const statusIssues = Arr.flatMap(details.agents, (agent) => agent.issues ?? []);
  const names = Arr.map(details.agents, (agent) => displayName(agent.name));
  const named = Arr.join(names, ", ");
  // How many agents were read in each state, as one combined counter.
  const states = Fn.pipe(
    Arr.groupBy(details.agents, (agent) => stateLabel(agent.state)),
    (groups) => Arr.map(Rec.toEntries(groups), ([state, agents]) => `${agents.length} ${state}`),
    Arr.join(" · "),
  );
  const agents = countLabel(details.agents.length, "agent");
  return settled(
    {
      expandLabel: readExpandLabel(details.agents),
      // A few agents read are named, as a wait names the runs it waited for.
      subject: single
        ? displayName(only.name)
        : names.length <= MAX_NAMED_AGENTS && named.length <= MAX_NAMED_AGENT_CHARS
          ? named
          : "",
      // The agents' states, such as `failed`, describe the agents; reading them is neutral.
      ...(details.agents.length > 0 && { subjectState: true as const }),
      counters: single
        ? [stateLabel(only.state)]
        : details.agents.length > 0
          ? [states, agents]
          : [agents],
      metadata: [
        ...(empty > 0 ? [single ? "no message yet" : `${empty} without a message`] : []),
        ...(truncated > 0 ? [single ? "truncated" : `${truncated} truncated`] : []),
      ],
    },
    [...statusIssues, ...missingIssue(details.missingIds)],
    "returned",
  );
};

const summarizeDetails = (details: AgentToolDetails): CompactSummary =>
  details.action === AGENT_TOOL_NAME.list
    ? summarizeList(details)
    : details.action === AGENT_TOOL_NAME.send
      ? summarizeSend(details)
      : summarizeRead(details);

const failureSubject = (tool: AgentToolName, args: AgentCallEvidence): string => {
  if (tool === AGENT_TOOL_NAME.send) return isMain(args.to) ? "The main agent" : "The agent";
  const ids = requestedIds(args);
  if (ids.length === 1) return ids[0] === MAIN_AGENT_ID ? "The main agent" : "The agent";
  return "The agents";
};

// The words a send carries, which only its expansion shows.
const sentWords = (args: AgentCallEvidence): Pick<CompactSummary, "expandLabel"> =>
  args.message !== undefined && Str.isNonEmpty(Str.trim(args.message))
    ? { expandLabel: "message" }
    : {};

const argumentLanes = (tool: AgentToolName, args: AgentCallEvidence): CompactSummary => {
  if (tool === AGENT_TOOL_NAME.send)
    return { subject: isMain(args.to) ? "main" : "", counters: [], ...sentWords(args) };
  const ids = requestedIds(args);
  return {
    subject: ids.length === 1 && ids[0] === MAIN_AGENT_ID ? "main" : "",
    counters: ids.length > 1 ? [countLabel(ids.length, "agent")] : [],
  };
};

/**
 * Compact headings for `agent_*`: what was listed, where a message went, whose message was read.
 * A collapsed compact row hides the listing and the words read, so its tag names them; a preview
 * row's body shows them, so its tag names only their `Details`.
 */
export const createAgentCompactSummary =
  (tool: AgentToolName, style: "compact" | "preview" = "compact"): CompactSummaryProvider =>
  ({ phase, args, result, context }) => {
    const input = decodeAgentCall(args);
    if (!input) return undefined;
    const lanes = argumentLanes(tool, input);
    if (!result) return context.isError || phase === "settled" ? undefined : lanes;
    if (context.isError) {
      if (phase !== "settled") return undefined;
      const issues = agentFailureIssues(
        rejectedFailure(result),
        tool === AGENT_TOOL_NAME.send ? "send" : tool === AGENT_TOOL_NAME.read ? "read" : "list",
        failureSubject(tool, input),
      );
      // A delivery that may have applied is uncertain, not failed.
      return {
        ...lanes,
        outcome: compactIssueSeverity(issues) === "error" ? "error" : "uncertain",
        issues,
      };
    }
    const details = decodeAgentToolDetails(result.details);
    if (details?.action !== tool) return undefined;
    const summary = summarizeDetails(details);
    if (tool === AGENT_TOOL_NAME.send) return { ...summary, ...sentWords(input) };
    return style === "preview" && summary.expandLabel !== false
      ? { ...summary, expandLabel: "details" }
      : summary;
  };
