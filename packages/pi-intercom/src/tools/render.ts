import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { getTextContent, previewIssuesSlot } from "pi-code-previews";
import { countLabel, formatBytes } from "pi-cosmic-core/display";
import { sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core/security";
import { clipToWidth } from "pi-cosmic-ui/manager";
import {
  composeToolComponent,
  renderExpansionAffordance,
  renderToolHeader,
  toolRunningLine,
  type ToolHeader,
} from "pi-cosmic-ui/tool";
import { detailsLine, statusLine, textBody } from "../display.ts";
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
import { sessionSubject, sessionToolDetails } from "./summary.ts";

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

const targetLabel = (to: string | undefined): string => sanitizeTerminalLine(to ?? "");

const heading = (tool: SessionToolName, target: string): ToolHeader => {
  if (tool === SESSION_TOOL.list) return { title: "Sessions" };
  if (tool === SESSION_TOOL.send) return { title: target ? `→ ${target}` : "Message" };
  return { title: target ? `← ${target}` : "Read", subtitle: "latest reply" };
};

const stacked = (parts: ReadonlyArray<Component>): Component => {
  const body = new Container();
  for (const part of parts) body.addChild(part);
  return body;
};

/** The message a send carries, from its arguments: bounded collapsed, complete expanded. */
const callBody = (args: SessionToolArgs, theme: Theme, expanded: boolean): Component =>
  Str.isNonEmpty(args.message ?? "")
    ? textBody(args.message ?? "", theme, expanded)
    : new Container();

/**
 * The heading names the session, by name once a result says it; a send's message follows it.
 * The heading reads the render state when it draws, after the result renderer has stored it.
 */
export const renderSessionCall =
  (tool: SessionToolName) =>
  (args: SessionToolArgs, theme: Theme, context: RenderContext): Component => {
    const { state } = context;
    const running = context.executionStarted && context.isPartial;
    const header = composeToolComponent((width) => {
      if (!Number.isFinite(width) || width < 1) return [];
      const target = state.sessionTarget ?? targetLabel(args.to);
      const lines = new Text(renderToolHeader(heading(tool, target), theme), 0, 0).render(width);
      return running ? [...lines, toolRunningLine(theme)] : lines;
    });
    const message =
      tool === SESSION_TOOL.send ? callBody(args, theme, context.expanded) : undefined;
    if (!context.expanded) return message ? stacked([header, message]) : header;
    return stacked([header, previewIssuesSlot(context), ...(message ? [message] : [])]);
  };

const STATE_COLORS = {
  idle: "muted",
  busy: "accent",
  unavailable: "warning",
  unresponsive: "warning",
  unreachable: "warning",
} as const satisfies Record<ListedSession["state"], "muted" | "accent" | "warning">;

const listedRow = (session: ListedSession, theme: Theme, expanded: boolean): string =>
  Arr.join(
    [
      theme.fg("toolOutput", sessionSubject(session)),
      theme.fg("dim", sanitizeTerminalLine(session.cwd)),
      theme.fg(STATE_COLORS[session.state], session.state),
      ...(session.duplicate ? [theme.fg("warning", "duplicate id")] : []),
      ...(expanded &&
      session.name !== undefined &&
      Str.isNonEmpty(sanitizeTerminalLine(session.name))
        ? [theme.fg("dim", sanitizeTerminalLine(session.sessionId))]
        : []),
    ],
    theme.fg("dim", " · "),
  );

const listBody = (
  details: Extract<SessionToolDetails, { readonly tool: "session_list" }>,
  theme: Theme,
  expanded: boolean,
): Component => {
  if (details.sessions.length === 0) return statusLine("No other live sessions", theme);
  const shown = expanded ? details.sessions : details.sessions.slice(0, MAX_COLLAPSED_SESSIONS);
  const hidden = details.sessions.length - shown.length + (expanded ? 0 : details.omitted);
  return composeToolComponent((width) => {
    if (!Number.isFinite(width) || width < 1) return [];
    const rows = Arr.map(shown, (session) =>
      clipToWidth(listedRow(session, theme, expanded), width),
    );
    if (expanded && details.omitted > 0)
      rows.push(clipToWidth(theme.fg("muted", `and ${details.omitted} more`), width));
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

/** The session's id and directory, and how it was addressed when no session answered. */
const sessionDetails = (
  session: SessionView | undefined,
  to: string | undefined,
  extra: ReadonlyArray<string>,
  theme: Theme,
): Component =>
  session
    ? detailsLine([`Session ${session.sessionId}`, session.cwd, ...extra], theme)
    : detailsLine([`Session ${targetLabel(to)}`, ...extra], theme);

const DELIVERY_STATUS = {
  woken: "Delivered; it started a turn to read it",
  queued: "Queued until its current turn ends",
  held: "Holding until its user's next prompt",
} as const;

const sendResult = (
  details: SessionSendDetails | SessionRefusal,
  to: string | undefined,
  theme: Theme,
  expanded: boolean,
): ReadonlyArray<Component> => {
  const status =
    details.outcome === "delivered" && (expanded || details.disposition !== "woken")
      ? [statusLine(DELIVERY_STATUS[details.disposition], theme)]
      : [];
  const session = "session" in details ? details.session : undefined;
  return expanded ? [...status, sessionDetails(session, to, [], theme)] : status;
};

const readResult = (
  details: SessionReadContract | SessionRefusal,
  to: string | undefined,
  theme: Theme,
  expanded: boolean,
): ReadonlyArray<Component> => {
  if ("outcome" in details) return expanded ? [sessionDetails(details.session, to, [], theme)] : [];
  const status = Arr.filter(
    [
      details.text === undefined ? "No reply yet" : "",
      details.state === "busy" ? "Still working" : "",
      expanded && details.truncated ? `Cut to the first ${formatBytes(MAX_READ_BYTES)}` : "",
    ],
    Str.isNonEmpty,
  );
  return [
    ...(details.text === undefined ? [] : [textBody(details.text, theme, expanded)]),
    ...(status.length > 0 ? [statusLine(Arr.join(status, " · "), theme)] : []),
    ...(expanded ? [sessionDetails(details.session, to, [details.state], theme)] : []),
  ];
};

const resultContent = (
  details: SessionToolDetails,
  args: SessionToolArgs,
  theme: Theme,
  expanded: boolean,
): ReadonlyArray<Component> => {
  if (details.tool === SESSION_TOOL.list) return [listBody(details, theme, expanded)];
  if (details.tool === SESSION_TOOL.send) return sendResult(details, args.to, theme, expanded);
  return readResult(details, args.to, theme, expanded);
};

/** A result whose details don't decode shows the text the agent read, as before. */
const fallbackText = (result: AgentToolResult<unknown>, theme: Theme): Component =>
  new Text(
    theme.fg(
      "toolOutput",
      Fn.pipe(stripTerminalControls(getTextContent(result.content)), Str.replace(/\n+$/u, "")),
    ),
    0,
    0,
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
    return stacked(resultContent(details, context.args, theme, options.expanded));
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
      ? stacked(resultContent(details, context.args, theme, true))
      : fallbackText(result, theme);
  },
});
