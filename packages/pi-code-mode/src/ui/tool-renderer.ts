/**
 * Pure humanized TUI presentation for the `code_mode` tool: intent headline, bounded
 * nested-call activity summaries, and collapsed/expanded call and result projections.
 *
 * Presentation only — nothing here mutates model-visible text, result details, or any
 * security budget. Every string that reaches the terminal goes through the shared
 * `pi-cosmic-core` sanitizers first, so hostile program output, hostile nested inputs, and
 * hostile persisted details can never inject terminal control sequences.
 */
import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Text, type Component } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core";
import { MAX_PROGRESS_ENTRIES, type CodeModeCallEntry } from "../tools/format.ts";

/** Neutral headline when the model provided no usable intent. */
export const CODE_MODE_FALLBACK_INTENT = "Read-only investigation";

/** Display bound (code points) for the sanitized intent headline. */
export const MAX_INTENT_DISPLAY_LENGTH = 160;

/** Display bound (code points) for one path/pattern/query inside an activity label. */
export const MAX_ACTIVITY_FIELD_LENGTH = 48;

/**
 * Display safety bound (code points) for the expanded program source. The configured
 * `maxSourceBytes` never exceeds 1 MiB, so any program `execute` accepts stays fully
 * inspectable; only hostile host-supplied argument blobs beyond that are bounded.
 */
export const MAX_SOURCE_DISPLAY_LENGTH = 1_048_576;

/** Code-point-safe truncation with a single-character ellipsis inside the budget. */
const truncateDisplay = (text: string, maxCodePoints: number): string => {
  const points = [...text];
  if (points.length <= maxCodePoints) return text;
  return `${points.slice(0, Math.max(0, maxCodePoints - 1)).join("")}…`;
};

/**
 * The sanitized bounded intent headline for one call, falling back to a neutral phrase for
 * a missing, non-string, or effectively empty intent.
 */
export const describeCodeModeIntent = (intent: unknown): string => {
  if (typeof intent !== "string") return CODE_MODE_FALLBACK_INTENT;
  const sanitized = sanitizeTerminalLine(intent);
  if (sanitized.length === 0) return CODE_MODE_FALLBACK_INTENT;
  return truncateDisplay(sanitized, MAX_INTENT_DISPLAY_LENGTH);
};

/** One sanitized bounded field read from a decoded nested-call input, if present. */
const activityField = (input: unknown, key: string): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  const sanitized = sanitizeTerminalLine(value);
  return sanitized.length === 0 ? undefined : truncateDisplay(sanitized, MAX_ACTIVITY_FIELD_LENGTH);
};

/**
 * A bounded human-readable activity label for one nested call, derived only from the
 * runtime-decoded input at call start (never from nested output). Unknown names and
 * hostile inputs collapse to a safe bounded fallback; raw objects are never stringified.
 */
export const describeNestedActivity = (name: unknown, input: unknown): string => {
  const toolName = typeof name === "string" ? name : "";
  const at = (fallback: string) => activityField(input, "path") ?? fallback;
  switch (toolName) {
    case "pi.read":
      return `Read ${at("file")}`;
    case "pi.grep":
      return `Search ${activityField(input, "pattern") ?? "pattern"} in ${at("cwd")}`;
    case "pi.find":
      return `Find ${activityField(input, "pattern") ?? "pattern"} in ${at("cwd")}`;
    case "pi.ls":
      return `List ${at("cwd")}`;
    case "$codemode.search": {
      const query = activityField(input, "query");
      return query === undefined ? "Discover tools" : `Discover tools for ${query}`;
    }
    default: {
      const sanitized = sanitizeTerminalLine(toolName);
      return sanitized.length === 0
        ? "Call tool"
        : `Call ${truncateDisplay(sanitized, MAX_ACTIVITY_FIELD_LENGTH)}`;
    }
  }
};

/** Presentation-side projection of the persisted `code_mode` result details. */
export interface CodeModeRenderDetails {
  readonly toolCalls: ReadonlyArray<CodeModeCallEntry>;
  readonly totalToolCalls: number;
  readonly cancelled: boolean;
  readonly truncated: boolean;
}

const decodeCallEntry = (value: unknown): CodeModeCallEntry | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  const status = entry.status;
  if (status !== "running" && status !== "completed" && status !== "error") return undefined;
  const tool = typeof entry.tool === "string" ? entry.tool : "";
  const activity = typeof entry.activity === "string" ? entry.activity : undefined;
  return { tool, status, ...(activity === undefined ? {} : { activity }) };
};

/**
 * Defensive decode of `result.details` for rendering: a hostile or legacy host may persist
 * anything, so at most `MAX_PROGRESS_ENTRIES` raw entries are ever inspected or
 * materialized (a huge or sparse hostile array never drives unbounded decode work),
 * malformed entries inside the bound are dropped, and the total stays consistent: it never
 * undercounts the raw array length (so `+N more` covers everything beyond the bounded
 * rows even without a valid persisted total) and accepts a larger persisted total only as
 * a safe non-negative integer.
 */
export const decodeCodeModeRenderDetails = (details: unknown): CodeModeRenderDetails => {
  const record =
    typeof details === "object" && details !== null ? (details as Record<string, unknown>) : {};
  const rawCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
  const toolCalls = rawCalls.slice(0, MAX_PROGRESS_ENTRIES).flatMap((entry) => {
    const decoded = decodeCallEntry(entry);
    return decoded === undefined ? [] : [decoded];
  });
  const suppliedTotal =
    typeof record.totalToolCalls === "number" &&
    Number.isSafeInteger(record.totalToolCalls) &&
    record.totalToolCalls >= 0
      ? record.totalToolCalls
      : 0;
  // An array length is always a bounded (≤ 2^32 − 1) safe integer, even for sparse arrays.
  const total = Math.max(toolCalls.length, rawCalls.length, suppliedTotal);
  return {
    toolCalls,
    totalToolCalls: total,
    cancelled: record.cancelled === true,
    truncated: record.truncated === true,
  };
};

const textContentOf = (result: AgentToolResult<unknown>): string => {
  const content: unknown = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part: unknown) => {
      if (typeof part !== "object" || part === null) return [];
      const record = part as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n");
};

const intentHeadline = (args: unknown, theme: Theme): string => {
  const intent = describeCodeModeIntent(
    typeof args === "object" && args !== null
      ? (args as Record<string, unknown>).intent
      : undefined,
  );
  return `${theme.fg("toolTitle", theme.bold("Code Mode"))} ${theme.fg("dim", `· ${intent}`)}`;
};

const sourceOf = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null) return undefined;
  const code = (args as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
};

/**
 * The structural subset of Pi's `ToolRenderContext` this pure module consumes (the full
 * context type is not re-exported from the package root). A cooperative shell may also
 * legitimately delegate with no context at all.
 */
export interface CodeModeRenderContext {
  readonly expanded: boolean;
  readonly isError?: boolean;
}

/**
 * Call projection: collapsed shows `Code Mode · <intent>` only; expanded adds the full
 * sanitized program source under a small label (newlines preserved, no JSON framing).
 */
export const renderCodeModeToolCall = (
  args: unknown,
  theme: Theme,
  context: CodeModeRenderContext | undefined,
): Component => {
  const header = new Text(intentHeadline(args, theme), 0, 0);
  if (context?.expanded !== true) return header;
  const container = new Container();
  container.addChild(header);
  container.addChild(new Text(theme.fg("muted", "Program"), 0, 0));
  const source = sourceOf(args);
  if (source === undefined) {
    container.addChild(new Text(theme.fg("dim", "(program not available)"), 0, 0));
    return container;
  }
  const sanitized = truncateDisplay(stripTerminalControls(source), MAX_SOURCE_DISPLAY_LENGTH);
  const body = sanitized
    .split("\n")
    .map((line) => theme.fg("toolOutput", line))
    .join("\n");
  container.addChild(new Text(body, 0, 0));
  return container;
};

const ACTIVITY_SYMBOLS = {
  running: { symbol: "…", color: "warning" },
  completed: { symbol: "✓", color: "success" },
  error: { symbol: "✗", color: "error" },
} as const;

const activityRow = (entry: CodeModeCallEntry, theme: Theme): string => {
  const { symbol, color } = ACTIVITY_SYMBOLS[entry.status];
  const label = entry.activity ?? describeNestedActivity(entry.tool, undefined);
  const sanitized = truncateDisplay(sanitizeTerminalLine(label), MAX_INTENT_DISPLAY_LENGTH);
  return `${theme.fg(color, symbol)} ${theme.fg("toolOutput", sanitized)}`;
};

const footerLine = (
  details: CodeModeRenderDetails,
  isPartial: boolean,
  isError: boolean,
  theme: Theme,
): string => {
  const total = details.totalToolCalls;
  const settled = details.toolCalls.filter((call) => call.status !== "running").length;
  const status = details.cancelled
    ? "Cancelled"
    : isError
      ? "Failed"
      : isPartial
        ? `${settled} of ${total} completed`
        : total === 0
          ? "Completed"
          : `${total} operation${total === 1 ? "" : "s"} completed`;
  const truncatedNote = details.truncated ? " · output truncated" : "";
  return theme.fg("muted", `${status}${truncatedNote}`);
};

const outputSection = (
  result: AgentToolResult<unknown>,
  isError: boolean,
  theme: Theme,
): ReadonlyArray<Component> => {
  const text = stripTerminalControls(textContentOf(result));
  if (text.length === 0) return [];
  const color = isError ? "error" : "toolOutput";
  const body = text
    .split("\n")
    .map((line) => theme.fg(color, line))
    .join("\n");
  return [new Text(theme.fg("muted", isError ? "Error" : "Output"), 0, 0), new Text(body, 0, 0)];
};

/**
 * Collapsed hint pointing at the hidden output/error: names the currently configured
 * `app.tools.expand` key(s) when bound (`▸ output · ctrl+o expand`, multiple keys joined
 * with `/`) and stays keyless when unbound (`▸ output · expand`). Reading the global TUI
 * keybindings accessor is a read-only presentation boundary, matching the
 * `pi-code-previews` and `pi-background-terminals` hints.
 */
const expandHintLine = (isError: boolean, theme: Theme): string => {
  const keys = getKeybindings().getKeys("app.tools.expand").join("/");
  const label = keys.length === 0 ? "expand" : `${keys} expand`;
  return theme.fg("dim", `▸ ${isError ? "error" : "output"} · ${label}`);
};

/**
 * Result projection: activity rows (running `…`, success `✓`, error `✗`), a `+N more`
 * marker beyond the bounded entries, and a muted status footer. Raw output stays hidden
 * while collapsed and appears complete (sanitized) under an `Output`/`Error` label when
 * expanded; partial snapshots never surface their placeholder progress text.
 */
export const renderCodeModeToolResult = (
  result: AgentToolResult<unknown>,
  options: Pick<ToolRenderResultOptions, "isPartial">,
  theme: Theme,
  context: CodeModeRenderContext | undefined,
): Component => {
  const details = decodeCodeModeRenderDetails(result.details);
  const isError = context?.isError === true;
  const expanded = context?.expanded === true;
  const container = new Container();
  for (const entry of details.toolCalls) {
    container.addChild(new Text(activityRow(entry, theme), 0, 0));
  }
  const hidden = details.totalToolCalls - details.toolCalls.length;
  if (hidden > 0) container.addChild(new Text(theme.fg("dim", `+${hidden} more`), 0, 0));
  container.addChild(new Text(footerLine(details, options.isPartial, isError, theme), 0, 0));
  if (options.isPartial) return container;
  if (expanded) {
    for (const component of outputSection(result, isError, theme)) container.addChild(component);
    return container;
  }
  if (stripTerminalControls(textContentOf(result)).length > 0) {
    container.addChild(new Text(expandHintLine(isError, theme), 0, 0));
  }
  return container;
};
