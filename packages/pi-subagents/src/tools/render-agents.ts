import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { countLabel } from "pi-cosmic-core/display";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { clipToWidth, managerActivityColor, type ManagerStatusColor } from "pi-cosmic-ui/manager";
import { composeToolComponent, renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { SUBAGENT_RUN_STATES } from "../run/model.ts";
import { expandedBody, expandedFields } from "pi-code-previews";
import {
  agentTextBlockLines,
  COLLAPSED_AGENT_TEXT_ROWS,
  expandedFactDetails,
  expandedRowsBody,
  factRowLines,
} from "../ui/agent-text.ts";
import { agentFactLines, savedAgentFactLines } from "../ui/run-facts.ts";
import {
  runStateColor,
  runStateLabel,
  runStateSnapshotGlyph,
  SNAPSHOT_RUNNING_GLYPH,
} from "../ui/run-state.ts";
import { quotesWhole } from "./compact-run-issues.ts";
import type { AgentToolDetails } from "./details-schema.ts";

type ListDetails = Extract<AgentToolDetails, { readonly action: "agent_list" }>;

/** Columns a listed agent's row nests beneath its parent's. */
const NESTED_ROW_INDENT = 2;
type SendDetails = Extract<AgentToolDetails, { readonly action: "agent_send" }>;
type ReadDetails = Extract<AgentToolDetails, { readonly action: "agent_read" }>;
type AgentState = ReadDetails["agents"][number]["state"];

const runState = (state: AgentState) =>
  Option.getOrUndefined(Arr.findFirst(SUBAGENT_RUN_STATES, (known) => known === state));

interface AgentStatePresentation {
  readonly glyph: string;
  readonly tone: ManagerStatusColor;
  readonly label: string;
}

/** The glyph, tone, and label of a run's state or the main agent's. */
export const agentStatePresentation = (state: AgentState): AgentStatePresentation => {
  const run = runState(state);
  if (run !== undefined)
    return {
      glyph: runStateSnapshotGlyph(run),
      tone: runStateColor(run),
      label: runStateLabel(run),
    };
  if (state === "busy")
    return {
      glyph: SNAPSHOT_RUNNING_GLYPH,
      tone: managerActivityColor("running"),
      label: "busy",
    };
  return { glyph: "•", tone: "muted", label: state };
};

// Short words for the heading; expansion explains them.
const SEND_STATUS: Record<
  NonNullable<SendDetails["mainState"]>,
  readonly [word: string, explanation: string] | undefined
> = {
  idle: undefined,
  busy: ["queued", "It reads the message when its current turn ends"],
  held: ["held", "It reads the message once you answer or send the next prompt"],
};

const sendOutcome = (details: SendDetails): readonly [string, string] | undefined => {
  switch (details.disposition) {
    case "answered":
      return ["answered", "Answered its pending question"];
    case "resumed":
      return ["resumed", "Resumed the finished run with this message as its next assignment"];
    case "guided":
      if (details.mainState !== undefined) return SEND_STATUS[details.mainState];
      return details.parked
        ? ["queued", "It reads the message once its own question is answered"]
        : undefined;
  }
  return Fn.absurd(details.disposition);
};

/** A send's outcome in a word, only when it departs from a plain delivery. */
export const sendStatus = (details: SendDetails): string | undefined => sendOutcome(details)?.[0];

/**
 * A send's outcome: collapsed, a word only when it departs from a plain delivery; expanded, what
 * the recipient does with the message and, in Details, who it is.
 */
export const renderSendResult = (
  details: SendDetails,
  expanded: boolean,
  theme: Theme,
): Component => {
  const outcome = sendOutcome(details);
  if (!expanded)
    return composeToolComponent((width) =>
      outcome ? [clipToWidth(theme.fg("muted", outcome[0]), Math.max(1, width))] : [],
    );
  return expandedBody(
    expandedFields(theme, [{ label: "Delivery", lines: outcome ? [outcome[1]] : [] }]),
    expandedFactDetails(
      theme,
      details.to === details.name ? [] : agentFactLines(details.name, [details.to]),
    ),
  );
};

/** One agent: collapsed, a clipped row; expanded, its whole task wraps beneath its name. */
const listRowLines = (
  entry: NonNullable<ListDetails["entries"]>[number],
  width: number,
  theme: Theme,
  expanded: boolean,
): string[] => {
  const { glyph, tone, label } = agentStatePresentation(entry.state);
  const indent =
    NESTED_ROW_INDENT * (entry.kind === "main" ? 0 : Math.max(0, (entry.depth ?? 1) - 1));
  // A question or a pause is the run's own state, in its tone; other statuses flag a problem.
  const statusTone =
    entry.state === "waiting_for_parent" || entry.state === "paused" ? tone : "warning";
  return factRowLines(
    [
      [glyph, tone],
      [" "],
      [sanitizeTerminalLine(entry.name), "toolTitle"],
      entry.status
        ? [` · ${sanitizeTerminalLine(entry.status)}`, statusTone]
        : [entry.kind === "main" ? ` · ${label}` : "", "muted"],
      [entry.task ? ` · ${sanitizeTerminalLine(entry.task)}` : "", "muted"],
    ],
    width,
    theme,
    expanded,
    // A wrapped row hangs two past its children's column, so its task never reads as a child.
    { indent, hang: visibleWidth(`${glyph} `) + NESTED_ROW_INDENT },
  );
};

/** Undefined when saved details carry no entries; their content then renders as text. */
export const renderListResult = (
  details: ListDetails,
  expanded: boolean,
  theme: Theme,
): Component | undefined => {
  const entries = details.entries;
  if (entries === undefined) return undefined;
  const rows = (width: number): string[] => {
    const safeWidth = Math.max(1, width);
    const shown =
      expanded || entries.length <= COLLAPSED_AGENT_TEXT_ROWS + 1
        ? entries
        : entries.slice(0, COLLAPSED_AGENT_TEXT_ROWS);
    const hidden = details.agentCount - shown.length;
    return [
      ...(entries.length === 0 ? [theme.fg("muted", "No matching agents")] : []),
      ...Arr.flatMap(shown, (entry) => listRowLines(entry, safeWidth, theme, expanded)),
      ...(hidden > 0
        ? [
            clipToWidth(
              expanded
                ? theme.fg("dim", `… ${countLabel(hidden, "more agent")}`)
                : renderExpansionAffordance(countLabel(hidden, "more agent"), false, theme),
              safeWidth,
            ),
          ]
        : []),
    ];
  };
  if (!expanded) return composeToolComponent(rows);
  return expandedRowsBody(
    theme,
    rows,
    Arr.flatMap(entries, (entry) =>
      entry.kind === "main" ? [] : agentFactLines(entry.name, [entry.facts ?? entry.id]),
    ),
  );
};

const READ_SOURCE_NOTES = {
  report: "report",
  error: "failure",
  assistant: undefined,
  question: undefined,
} as const;

/** Undefined when saved details carry no display copies; their content then renders as text. */
export const renderReadResult = (
  details: ReadDetails,
  expanded: boolean,
  theme: Theme,
): Component | undefined => {
  const agents = details.agents;
  // Details saved before display copies existed fall back to the text the agent read.
  if (
    agents.length > 0 &&
    Arr.every(agents, (agent) => agent.textStatus === "text" && agent.text === undefined)
  )
    return undefined;
  const blocks = Arr.map(agents, (agent) => {
    const { glyph, tone, label } = agentStatePresentation(agent.state);
    // A failed run's words are its failure, which its state already says.
    const source =
      agent.source === undefined || (agent.source === "error" && agent.state === "failed")
        ? undefined
        : READ_SOURCE_NOTES[agent.source];
    // A question is its issue's quote; expansion adds the whole of a long one.
    const hidden =
      agent.source === "question" &&
      (!expanded || agent.text === undefined || quotesWhole(agent.text));
    return {
      glyph,
      tone,
      name: agent.name,
      status: Arr.join(
        Arr.filter([label, source], (part) => part !== undefined),
        " · ",
      ),
      text: hidden ? undefined : agent.text,
      notes: [
        ...(agent.notes ?? []),
        ...(agent.text === undefined && !agent.notes?.length
          ? [agent.source === "report" ? "Report saved to a file" : "No message yet"]
          : []),
        ...(agent.textCut && !hidden ? ["Shown up to its display limit"] : []),
      ],
    };
  });
  const rows = (width: number) => agentTextBlockLines(blocks, width, theme, expanded);
  if (!expanded) return composeToolComponent(rows);
  return expandedRowsBody(
    theme,
    rows,
    Arr.flatMap(agents, (agent) =>
      agent.facts === undefined ? [] : savedAgentFactLines(agent.name, agent.facts),
    ),
  );
};
