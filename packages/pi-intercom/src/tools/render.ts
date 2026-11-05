import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import {
  expandedAuthoredText,
  expandedBody,
  expandedDetails,
  expandedFields,
  expandedText,
  getTextContent,
  previewIssuesSlot,
  expandedSection,
  type ExpandedField,
} from "pi-code-previews";
import { countLabel, formatBytes } from "pi-cosmic-core/display";
import { clipToWidth, SUITE_STATUS_GLYPHS } from "pi-cosmic-ui/manager";
import {
  composeToolComponent,
  renderExpansionAffordance,
  renderToolHeader,
  toolRunningLine,
  type ToolHeader,
} from "pi-cosmic-ui/tool";
import {
  displayDirectory,
  PREVIEW_BODY_INDENT,
  sessionDetails,
  sessionText,
  statusLine,
  textBody,
} from "../display.ts";
import { MAX_READ_BYTES } from "../transport/protocol.ts";
import {
  SESSION_TOOL,
  type ListedSession,
  type SessionReadContract,
  type SessionRefusal,
  type SessionSendDetails,
  type SessionToolArgs,
  type SessionToolDetails,
  type SessionToolName,
  type SessionView,
} from "./contract.ts";
import {
  distinctSessionLabels,
  knownAddresseeSubject,
  SESSION_STATE_LABELS,
  sessionSubject,
  type SessionNames,
} from "../identity.ts";
import { NO_OTHER_SESSIONS, sessionToolDetails } from "./summary.ts";

/** What a settled result tells the call heading, which renders before it is known. */
export interface SessionRenderState {
  sessionTarget?: string | undefined;
}

/** The parts of Pi's render context these renderers read. */
interface RenderContext {
  readonly args: SessionToolArgs;
  readonly state: SessionRenderState;
  readonly expanded: boolean;
  readonly executionStarted: boolean;
  readonly isPartial: boolean;
}

const MAX_COLLAPSED_SESSIONS = 6;

/** `Message → web work` and `Reply ← web work`, as the suite names messages between agents. */
const heading = (tool: SessionToolName, target: string): ToolHeader => {
  if (tool === SESSION_TOOL.list) return { title: "Sessions" };
  if (tool === SESSION_TOOL.send) return { title: target ? `Message → ${target}` : "Message" };
  return { title: target ? `Reply ← ${target}` : "Reply" };
};

const stacked = (parts: ReadonlyArray<Component>): Component => {
  const body = new Container();
  for (const part of parts) body.addChild(part);
  return body;
};

/** The message a send carries, from its arguments: bounded collapsed, a complete section expanded. */
const callBody = (args: SessionToolArgs, theme: Theme, expanded: boolean): Component => {
  const message = args.message ?? "";
  if (!Str.isNonEmpty(message)) return new Container();
  return expanded
    ? expandedAuthoredText(theme, "Message", sessionText(message))
    : textBody(message, theme, false, PREVIEW_BODY_INDENT);
};

/**
 * The heading names the session, by name once a result says it; a send's message follows it.
 * The heading reads the render state when it draws, after the result renderer has stored it.
 */
export const renderSessionCall =
  (tool: SessionToolName, names?: SessionNames) =>
  (args: SessionToolArgs, theme: Theme, context: RenderContext): Component => {
    const { state } = context;
    const running = context.executionStarted && context.isPartial;
    const header = composeToolComponent((width) => {
      if (!Number.isFinite(width) || width < 1) return [];
      const target = state.sessionTarget ?? knownAddresseeSubject(args.to, names);
      return new Text(renderToolHeader(heading(tool, target), theme), 0, 0).render(width);
    });
    const runningLine = composeToolComponent((width) =>
      running && width >= 1 ? [toolRunningLine(theme)] : [],
    );
    const message =
      tool === SESSION_TOOL.send ? callBody(args, theme, context.expanded) : undefined;
    // Issues follow the heading, so an expanded preview row reuses only the heading above them.
    return stacked([
      header,
      previewIssuesSlot(context),
      runningLine,
      ...(message ? [message] : []),
    ]);
  };

const STATE_COLORS = {
  idle: "muted",
  busy: "accent",
  unavailable: "warning",
  unresponsive: "warning",
  unreachable: "warning",
} as const satisfies Record<ListedSession["state"], "muted" | "accent" | "warning">;

/**
 * Each listed session's status glyph: idle is done with its turn, busy was working when the list
 * was taken, unavailable and not answering couldn't confirm their state, and unreachable failed.
 */
const STATE_GLYPHS = {
  idle: { glyph: SUITE_STATUS_GLYPHS.succeeded, color: "success" },
  busy: { glyph: SUITE_STATUS_GLYPHS.neutral, color: "accent" },
  unavailable: { glyph: SUITE_STATUS_GLYPHS.uncertain, color: "warning" },
  unresponsive: { glyph: SUITE_STATUS_GLYPHS.uncertain, color: "warning" },
  unreachable: { glyph: SUITE_STATUS_GLYPHS.failed, color: "error" },
} as const satisfies Record<
  ListedSession["state"],
  { readonly glyph: string; readonly color: "success" | "accent" | "warning" | "error" }
>;

type ListDetails = Extract<SessionToolDetails, { readonly tool: "session_list" }>;

/**
 * A listed session: its status glyph, label, and state, then its `~` directory when expanded.
 * Columns after the glyph hang beneath the label when the row wraps.
 */
const listedRow = (session: ListedSession, label: string, theme: Theme, expanded: boolean) => {
  const { glyph, color } = STATE_GLYPHS[session.state];
  return `${theme.fg(color, glyph)} ${Arr.join(
    [
      theme.fg("toolOutput", label),
      theme.fg(STATE_COLORS[session.state], SESSION_STATE_LABELS[session.state]),
      ...(session.duplicate ? [theme.fg("warning", "duplicate id")] : []),
      ...(expanded ? [theme.fg("muted", displayDirectory(session.cwd))] : []),
    ],
    theme.fg("dim", " · "),
  )}`;
};

const LISTED_ROW_HANG = 2;

const NO_SESSIONS = Str.capitalize(NO_OTHER_SESSIONS);

/**
 * Expanded, every session on its own wrapped row; full ids close in `Details`. A compact heading
 * already says when there are none.
 */
const listExpanded = (details: ListDetails, theme: Theme, compact: boolean): Component => {
  if (details.sessions.length === 0)
    return compact
      ? new Container()
      : expandedText(theme, undefined, [{ text: NO_SESSIONS, tone: "muted" }]);
  const labels = distinctSessionLabels(details.sessions);
  const label = (index: number) => labels[index] ?? "";
  const rows = composeToolComponent((width) => {
    if (!Number.isFinite(width) || width < 1) return [];
    const hang = Fn.pipe(" ", Str.repeat(Math.min(LISTED_ROW_HANG, width - 1)));
    return [
      ...Arr.flatMap(details.sessions, (session, index) =>
        Arr.map(
          wrapTextWithAnsi(
            listedRow(session, label(index), theme, true),
            Math.max(1, width - LISTED_ROW_HANG),
          ),
          (row, line) => (line === 0 ? row : `${hang}${row}`),
        ),
      ),
      ...(details.omitted > 0 ? [theme.fg("muted", `and ${details.omitted} more`)] : []),
    ];
  });
  return expandedBody(
    expandedSection(theme, undefined, rows),
    expandedDetails(
      theme,
      Arr.map(details.sessions, (session, index) => `${label(index)} · ${session.sessionId}`),
    ),
  );
};

const listBody = (details: ListDetails, theme: Theme): Component => {
  if (details.sessions.length === 0) return statusLine(NO_SESSIONS, theme);
  const labels = distinctSessionLabels(details.sessions);
  const shown = details.sessions.slice(0, MAX_COLLAPSED_SESSIONS);
  const hidden = details.sessions.length - shown.length + details.omitted;
  return composeToolComponent((width) => {
    if (!Number.isFinite(width) || width < 1) return [];
    const rows = Arr.map(shown, (session, index) =>
      clipToWidth(
        listedRow(session, labels[index] ?? sessionSubject(session), theme, false),
        width,
      ),
    );
    if (hidden > 0)
      rows.push(
        clipToWidth(
          renderExpansionAffordance(countLabel(hidden, "more session"), false, theme),
          width,
          "",
        ),
      );
    return rows;
  });
};

/** The `Details` section: the session's id and directory, or how it was addressed. */
const detailsOf = (session: SessionView | undefined, to: string | undefined, theme: Theme) =>
  sessionDetails(theme, session?.sessionId ?? to ?? "", session?.cwd);

/** How a recipient reads a message, worth saying only when it waits; a woken one reads it now. */
const DELIVERY_STATUS = {
  woken: undefined,
  queued: "Queued until its current turn ends",
  held: "Held until its user's next prompt",
} as const;

type SendOutcome = SessionSendDetails | SessionRefusal;
type ReadOutcome = SessionReadContract | SessionRefusal;

/** Collapsed, a delivery shows how it will be read only when that departs from the usual. */
const deliveryStatus = (details: SendOutcome): string | undefined =>
  details.outcome === "delivered" ? DELIVERY_STATUS[details.disposition] : undefined;

const sendCollapsed = (details: SendOutcome, theme: Theme): ReadonlyArray<Component> => {
  const status = deliveryStatus(details);
  return status === undefined ? [] : [statusLine(status, theme)];
};

const sendExpanded = (details: SendOutcome, to: string | undefined, theme: Theme): Component => {
  const status = deliveryStatus(details);
  return expandedBody(
    status === undefined
      ? undefined
      : expandedFields(theme, [{ label: "Delivery", lines: [status] }]),
    detailsOf("session" in details ? details.session : undefined, to, theme),
  );
};

/** The reply's text, unless the latest message has none to show. */
const replyText = (details: SessionReadContract): string | undefined =>
  details.text !== undefined && Str.isNonEmpty(Str.trim(details.text)) ? details.text : undefined;

const readStatus = (details: SessionReadContract): ReadonlyArray<string> =>
  Arr.filter(
    [
      replyText(details) === undefined ? "No reply yet" : "",
      details.state === "busy" ? "Still working" : "",
    ],
    Str.isNonEmpty,
  );

const readCollapsed = (details: ReadOutcome, theme: Theme): ReadonlyArray<Component> => {
  if ("outcome" in details) return [];
  const status = readStatus(details);
  const reply = replyText(details);
  return [
    ...(reply === undefined ? [] : [textBody(reply, theme, false, PREVIEW_BODY_INDENT)]),
    ...(status.length > 0 ? [statusLine(Arr.join(status, " · "), theme)] : []),
  ];
};

/**
 * Expanded, the reply in full, then the session's state, then its id and directory. A compact
 * heading already says when there is no reply yet; a preview heading doesn't.
 */
const readExpanded = (
  details: ReadOutcome,
  to: string | undefined,
  theme: Theme,
  compact: boolean,
): Component => {
  if ("outcome" in details) return detailsOf(details.session, to, theme);
  const reply = replyText(details);
  const noReply: ReadonlyArray<ExpandedField> =
    reply === undefined && !compact
      ? [{ label: "Reply", lines: [{ text: "No reply yet", tone: "muted" }] }]
      : [];
  return expandedBody(
    expandedAuthoredText(theme, "Reply", reply && sessionText(reply)),
    expandedFields(theme, [
      ...noReply,
      { label: "State", lines: [SESSION_STATE_LABELS[details.state]] },
      ...(details.truncated
        ? [{ label: "Length", lines: [`Cut to the first ${formatBytes(MAX_READ_BYTES)}`] }]
        : []),
    ]),
    detailsOf(details.session, to, theme),
  );
};

const collapsedContent = (details: SessionToolDetails, theme: Theme): ReadonlyArray<Component> => {
  if (details.tool === SESSION_TOOL.list) return [listBody(details, theme)];
  if (details.tool === SESSION_TOOL.send) return sendCollapsed(details, theme);
  return readCollapsed(details, theme);
};

const expandedContent = (
  details: SessionToolDetails,
  args: SessionToolArgs,
  theme: Theme,
  compact: boolean,
): Component => {
  if (details.tool === SESSION_TOOL.list) return listExpanded(details, theme, compact);
  if (details.tool === SESSION_TOOL.send) return sendExpanded(details, args.to, theme);
  return readExpanded(details, args.to, theme, compact);
};

/** A result whose details don't decode shows the text the agent read, as before. */
const fallbackText = (result: AgentToolResult<unknown>, theme: Theme): Component =>
  expandedText(
    theme,
    undefined,
    Fn.pipe(getTextContent(result.content), Str.replace(/\n+$/u, ""), Str.split("\n")),
  );

const settledTarget = (details: SessionToolDetails): string => {
  if (details.tool === SESSION_TOOL.list) return "";
  return "session" in details && details.session ? sessionSubject(details.session) : "";
};

export const renderSessionResult =
  (tool: SessionToolName) =>
  (
    result: AgentToolResult<unknown>,
    options: { readonly expanded: boolean; readonly isPartial: boolean },
    theme: Theme,
    context: RenderContext,
  ): Component => {
    if (options.isPartial) return new Container();
    const details = sessionToolDetails(tool, result);
    const target = details ? settledTarget(details) : "";
    context.state.sessionTarget = Str.isNonEmpty(target) ? target : undefined;
    if (!details) return options.expanded ? fallbackText(result, theme) : new Container();
    return options.expanded
      ? expandedContent(details, context.args, theme, false)
      : stacked(collapsedContent(details, theme));
  };

/** Content compact expansion shows below the shared heading and issues. */
export const sessionExpandedContent = (tool: SessionToolName) => ({
  renderCall: (args: SessionToolArgs, theme: Theme): Component =>
    tool === SESSION_TOOL.send ? callBody(args, theme, true) : new Container(),
  renderResult: (
    result: AgentToolResult<unknown>,
    _options: ToolRenderResultOptions,
    theme: Theme,
    context: RenderContext,
  ): Component => {
    const details = sessionToolDetails(tool, result);
    return details
      ? expandedContent(details, context.args, theme, true)
      : fallbackText(result, theme);
  },
});
