import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { countLabel } from "pi-cosmic-core/display";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import {
  clipToWidth,
  managerActivityColor,
  managerActivityGlyph,
  type ManagerStatusColor,
} from "pi-cosmic-ui/manager";
import { composeToolComponent, renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { SUBAGENT_RUN_STATES } from "../run/model.ts";
import {
  agentTextBlockLines,
  COLLAPSED_AGENT_TEXT_ROWS,
  detailsSectionLines,
} from "../ui/agent-text.ts";
import { runStateColor, runStateGlyph, runStateLabel } from "../ui/run-state.ts";
import type { AgentToolDetails } from "./details-schema.ts";

type ListDetails = Extract<AgentToolDetails, { readonly action: "agent_list" }>;
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
    return { glyph: runStateGlyph(run), tone: runStateColor(run), label: runStateLabel(run) };
  if (state === "busy")
    return {
      glyph: managerActivityGlyph("running"),
      tone: managerActivityColor("running"),
      label: "busy",
    };
  return { glyph: "•", tone: "muted", label: state };
};

const SEND_STATUS: Record<NonNullable<SendDetails["mainState"]>, string | undefined> = {
  idle: undefined,
  busy: "queued until its current turn ends",
  held: "waiting for the user",
};

/** A send's outcome in a few words, only when it departs from a plain delivery. */
export const sendStatus = (details: SendDetails): string | undefined => {
  switch (details.disposition) {
    case "answered":
      return "answered its question";
    case "resumed":
      return "resumed it with this message";
    case "guided":
      if (details.mainState !== undefined) return SEND_STATUS[details.mainState];
      return details.parked ? "waits until its own question is answered" : undefined;
  }
  return Fn.absurd(details.disposition);
};

export const renderSendResult = (
  details: SendDetails,
  expanded: boolean,
  theme: Theme,
): Component =>
  composeToolComponent((width) => {
    const safeWidth = Math.max(1, width);
    const status = sendStatus(details);
    return [
      ...(status ? [clipToWidth(theme.fg("muted", status), safeWidth)] : []),
      ...(expanded
        ? detailsSectionLines(
            [`To ${sanitizeTerminalLine(details.name)} (${sanitizeTerminalLine(details.to)})`],
            safeWidth,
            theme,
          )
        : []),
    ];
  });

const listRow = (
  entry: NonNullable<ListDetails["entries"]>[number],
  width: number,
  theme: Theme,
): string => {
  const { glyph, tone, label } = agentStatePresentation(entry.state);
  const indent = Fn.pipe(
    "  ",
    Str.repeat(entry.kind === "main" ? 0 : Math.max(0, (entry.depth ?? 1) - 1)),
  );
  const name = theme.fg("toolTitle", sanitizeTerminalLine(entry.name));
  // A question or a pause is the run's own state, in its tone; other statuses flag a problem.
  const statusTone =
    entry.state === "waiting_for_parent" || entry.state === "paused" ? tone : "warning";
  const status = entry.status
    ? theme.fg(statusTone, ` · ${sanitizeTerminalLine(entry.status)}`)
    : entry.kind === "main"
      ? theme.fg("muted", ` · ${label}`)
      : "";
  const task = entry.task ? theme.fg("muted", ` · ${sanitizeTerminalLine(entry.task)}`) : "";
  return clipToWidth(`${indent}${theme.fg(tone, glyph)} ${name}${status}${task}`, width);
};

/** Undefined when saved details carry no entries; their content then renders as text. */
export const renderListResult = (
  details: ListDetails,
  expanded: boolean,
  theme: Theme,
): Component | undefined => {
  const entries = details.entries;
  if (entries === undefined) return undefined;
  return composeToolComponent((width) => {
    const safeWidth = Math.max(1, width);
    const shown =
      expanded || entries.length <= COLLAPSED_AGENT_TEXT_ROWS + 1
        ? entries
        : entries.slice(0, COLLAPSED_AGENT_TEXT_ROWS);
    const hidden = details.agentCount - shown.length;
    return [
      ...(entries.length === 0 ? [theme.fg("muted", "No matching agents")] : []),
      ...Arr.map(shown, (entry) => listRow(entry, safeWidth, theme)),
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
      ...(expanded
        ? detailsSectionLines(
            Arr.flatMap(entries, (entry) =>
              entry.kind === "main" ? [] : [`${entry.name}: ${entry.facts ?? entry.id}`],
            ),
            safeWidth,
            theme,
          )
        : []),
    ];
  });
};

const READ_SOURCE_NOTES = { report: "report", error: "failure", assistant: undefined } as const;

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
  return composeToolComponent((width) => {
    const safeWidth = Math.max(1, width);
    const blocks = Arr.map(agents, (agent) => {
      const { glyph, tone, label } = agentStatePresentation(agent.state);
      // A failed run's words are its failure, which its state already says.
      const source =
        agent.source === undefined || (agent.source === "error" && agent.state === "failed")
          ? undefined
          : READ_SOURCE_NOTES[agent.source];
      return {
        glyph,
        tone,
        name: agent.name,
        status: Arr.join(
          Arr.filter([label, source], (part) => part !== undefined),
          " · ",
        ),
        text: agent.text,
        notes: [
          ...(agent.notes ?? []),
          ...(agent.text === undefined && !agent.notes?.length
            ? [agent.source === "report" ? "Report saved to a file" : "No message yet"]
            : []),
          ...(agent.textCut ? ["Shown up to its display limit"] : []),
        ],
      };
    });
    return [
      ...agentTextBlockLines(blocks, safeWidth, theme, expanded),
      ...(expanded
        ? detailsSectionLines(
            Arr.flatMap(agents, (agent) =>
              agent.facts === undefined ? [] : [`${agent.name}: ${Arr.join(agent.facts, " · ")}`],
            ),
            safeWidth,
            theme,
          )
        : []),
    ];
  });
};
