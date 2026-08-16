/**
 * Pure humanized TUI presentation for the `code_mode` tool: intent headline, bounded
 * nested-call activity summaries, and collapsed/expanded call and result projections.
 *
 * Presentation only — nothing here mutates model-visible text, result details, or any
 * security budget. Every string that reaches the terminal goes through the shared
 * `pi-cosmic-core` sanitizers first, so hostile program output, hostile nested inputs, and
 * hostile persisted details can never inject terminal control sequences.
 */
import * as Predicate from "effect/Predicate";

import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Text, type Component } from "@earendil-works/pi-tui";
import * as codePreviews from "pi-code-previews";
import { sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { brailleSpinnerFrame, managerStateGlyph, startingSpinnerFrame } from "pi-cosmic-ui/manager";
import { CODE_MODE_INTEGER_BOUNDS } from "../config/schema.ts";
import {
  describeNestedActivity,
  MAX_INTENT_LENGTH,
  MAX_PROGRESS_ENTRIES,
  truncateDisplay,
  type CodeModeCallCounts,
  type CodeModeCallEntry,
} from "../tools/format.ts";
import { codeModeOutputText, projectStructuredCodeModeOutput } from "./result-output.ts";

/** Neutral headline when the model provided no usable intent. */
export const CODE_MODE_FALLBACK_INTENT = "Tool orchestration";

/**
 * Display safety bound (code points) for the expanded program source: the configured
 * `maxSourceBytes` maximum (code points never exceed UTF-8 bytes), so any program `execute`
 * accepts stays fully inspectable; only hostile host-supplied argument blobs beyond that
 * are bounded.
 */
export const MAX_SOURCE_DISPLAY_LENGTH = CODE_MODE_INTEGER_BOUNDS.maxSourceBytes.maximum;

/**
 * The sanitized bounded intent headline for one call, falling back to a neutral phrase for
 * a missing, non-string, or effectively empty intent.
 */
export const describeCodeModeIntent = <Intent>(intent: Intent): string => {
  if (!Predicate.isString(intent)) return CODE_MODE_FALLBACK_INTENT;
  const sanitized = sanitizeTerminalLine(intent);
  if (sanitized.length === 0) return CODE_MODE_FALLBACK_INTENT;
  return truncateDisplay(sanitized, MAX_INTENT_LENGTH);
};

/** Presentation-side projection of the persisted `code_mode` result details. */
interface DecodedCodeModeCallEntry {
  tool: string;
  status: CodeModeCallEntry["status"];
  activity?: string;
  durationMs?: number;
}

interface MutableCodeModeRenderDetails {
  toolCalls: ReadonlyArray<CodeModeCallEntry>;
  totalToolCalls: number;
  counts: CodeModeCallCounts;
  hasExactCounts: boolean;
  outputKind?: "text" | "structured";
  cancelled: boolean;
  truncated: boolean;
}

export interface CodeModeRenderDetails {
  readonly toolCalls: ReadonlyArray<CodeModeCallEntry>;
  readonly totalToolCalls: number;
  readonly counts: CodeModeCallCounts;
  readonly hasExactCounts: boolean;
  readonly outputKind?: "text" | "structured";
  readonly cancelled: boolean;
  readonly truncated: boolean;
}

const safeInteger = <Value>(value: Value): number | undefined =>
  Predicate.isNumber(value) && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const CallEntryInputSchema = Schema.Struct({
  status: Schema.Unknown,
  tool: Schema.optional(Schema.Unknown),
  activity: Schema.optional(Schema.Unknown),
  durationMs: Schema.optional(Schema.Unknown),
});
const RenderDetailsInputSchema = Schema.Struct({
  toolCalls: Schema.optional(Schema.Unknown),
  totalToolCalls: Schema.optional(Schema.Unknown),
  counts: Schema.optional(Schema.Unknown),
  outputKind: Schema.optional(Schema.Unknown),
  cancelled: Schema.optional(Schema.Unknown),
  truncated: Schema.optional(Schema.Unknown),
});
const CallCountsInputSchema = Schema.Struct({
  total: Schema.Unknown,
  queued: Schema.Unknown,
  running: Schema.Unknown,
  succeeded: Schema.Unknown,
  failed: Schema.Unknown,
  cancelled: Schema.Unknown,
});
const TextContentPartInputSchema = Schema.Struct({
  type: Schema.Unknown,
  text: Schema.Unknown,
});
const CodeModeArgumentsInputSchema = Schema.Struct({
  intent: Schema.optional(Schema.Unknown),
  code: Schema.optional(Schema.Unknown),
});

const decodeInput = <S extends Schema.ConstraintDecoder<unknown>, Value>(
  schema: S,
  value: Value,
): S["Type"] | undefined => {
  const decoded = Schema.decodeUnknownOption(schema)(value);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

const decodeCallEntry = <Value>(value: Value): CodeModeCallEntry | undefined => {
  const entry = decodeInput(CallEntryInputSchema, value);
  if (entry === undefined) return undefined;
  const status = entry.status;
  if (
    status !== "queued" &&
    status !== "running" &&
    status !== "completed" &&
    status !== "error" &&
    status !== "cancelled"
  )
    return undefined;
  const tool = Predicate.isString(entry.tool) ? entry.tool : "";
  const activity = Predicate.isString(entry.activity) ? entry.activity : undefined;
  const durationMs = safeInteger(entry.durationMs);
  const decodedEntry: DecodedCodeModeCallEntry = { tool, status };
  if (activity !== undefined) decodedEntry.activity = activity;
  if (durationMs !== undefined) decodedEntry.durationMs = durationMs;
  return decodedEntry;
};

/**
 * Defensive decode of `result.details` for rendering: a hostile or legacy host may persist
 * anything, so at most `MAX_PROGRESS_ENTRIES` raw entries are ever inspected or
 * materialized (a huge or sparse hostile array never drives unbounded decode work),
 * malformed entries inside the bound are dropped, and the total stays consistent: it never
 * undercounts the raw array length (so legacy `+N more` or modern `+N earlier` covers
 * everything beyond the bounded rows) and accepts a larger persisted total only as
 * a safe non-negative integer.
 */
export const decodeCodeModeRenderDetails = <Details>(details: Details): CodeModeRenderDetails => {
  const record = decodeInput(RenderDetailsInputSchema, details) ?? {};
  const rawCalls = Array.isArray(record.toolCalls) ? record.toolCalls : [];
  const toolCalls = rawCalls.slice(0, MAX_PROGRESS_ENTRIES).flatMap((entry) => {
    const decoded = decodeCallEntry(entry);
    return decoded === undefined ? [] : [decoded];
  });
  const suppliedTotal = safeInteger(record.totalToolCalls) ?? 0;
  const rawCounts = decodeInput(CallCountsInputSchema, record.counts);
  const hasExactCounts =
    rawCounts !== undefined &&
    [
      rawCounts.total,
      rawCounts.queued,
      rawCounts.running,
      rawCounts.succeeded,
      rawCounts.failed,
      rawCounts.cancelled,
    ].every((count) => safeInteger(count) !== undefined);
  const visible = {
    queued: toolCalls.filter((call) => call.status === "queued").length,
    running: toolCalls.filter((call) => call.status === "running").length,
    succeeded: toolCalls.filter((call) => call.status === "completed").length,
    failed: toolCalls.filter((call) => call.status === "error").length,
    cancelled: toolCalls.filter((call) => call.status === "cancelled").length,
  };
  const suppliedCounts = hasExactCounts
    ? {
        queued: Math.max(visible.queued, safeInteger(rawCounts.queued) ?? 0),
        running: Math.max(visible.running, safeInteger(rawCounts.running) ?? 0),
        succeeded: Math.max(visible.succeeded, safeInteger(rawCounts.succeeded) ?? 0),
        failed: Math.max(visible.failed, safeInteger(rawCounts.failed) ?? 0),
        cancelled: Math.max(visible.cancelled, safeInteger(rawCounts.cancelled) ?? 0),
      }
    : undefined;
  const suppliedCountTotal =
    suppliedCounts === undefined
      ? 0
      : Object.values(suppliedCounts).reduce((total, count) => total + count, 0);
  const total = Math.max(
    toolCalls.length,
    rawCalls.length,
    suppliedTotal,
    hasExactCounts ? (safeInteger(rawCounts.total) ?? 0) : 0,
    suppliedCountTotal,
  );
  const hiddenLegacySucceeded = hasExactCounts ? 0 : Math.max(0, total - toolCalls.length);
  const counts: CodeModeCallCounts = hasExactCounts
    ? { total, ...(suppliedCounts ?? visible) }
    : { total, ...visible, succeeded: visible.succeeded + hiddenLegacySucceeded };
  const decodedDetails: MutableCodeModeRenderDetails = {
    toolCalls,
    totalToolCalls: total,
    counts,
    hasExactCounts,
    cancelled: record.cancelled === true,
    truncated: record.truncated === true,
  };
  if (record.outputKind === "text" || record.outputKind === "structured")
    decodedDetails.outputKind = record.outputKind;
  return decodedDetails;
};

const textContentOf = (result: AgentToolResult<unknown>): string => {
  const content: unknown = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const record = decodeInput(TextContentPartInputSchema, part);
      return record?.type === "text" && Predicate.isString(record.text) ? [record.text] : [];
    })
    .join("\n");
};

const intentHeadline = <Args>(args: Args, theme: Theme): string => {
  const intent = describeCodeModeIntent(decodeInput(CodeModeArgumentsInputSchema, args)?.intent);
  return `${theme.fg("toolTitle", theme.bold("Code Mode"))} ${theme.fg("dim", `· ${intent}`)}`;
};

const sourceOf = <Args>(args: Args): string | undefined => {
  const code = decodeInput(CodeModeArgumentsInputSchema, args)?.code;
  return Predicate.isString(code) ? code : undefined;
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
export const renderCodeModeToolCall = <Args>(
  args: Args,
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
  queued: { symbol: startingSpinnerFrame(0), color: "dim" },
  completed: { symbol: managerStateGlyph("done"), color: "success" },
  error: { symbol: managerStateGlyph("failed"), color: "error" },
  cancelled: { symbol: managerStateGlyph("stopped"), color: "muted" },
} as const;

export const formatCallDuration = (durationMs: number): string =>
  durationMs < 1_000
    ? `${durationMs}ms`
    : durationMs < 10_000
      ? `${(durationMs / 1_000).toFixed(1)}s`
      : `${Math.round(durationMs / 1_000)}s`;

type ToolIconLookup = (tool: string) => string | undefined;

/** Optional cross-package presentation must never take down the complete result renderer. */
export const nestedToolIcon = (
  tool: string,
  lookup: ToolIconLookup | null | undefined = codePreviews.getCodePreviewToolIcon,
): string | undefined => {
  if (!tool.startsWith("pi.") || !Predicate.isFunction(lookup)) return undefined;
  try {
    // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
    const icon = (lookup as ToolIconLookup)(tool.slice("pi.".length));
    if (!Predicate.isString(icon)) return undefined;
    const sanitized = truncateDisplay(sanitizeTerminalLine(icon), 8);
    return sanitized.length === 0 ? undefined : sanitized;
  } catch {
    return undefined;
  }
};

const activityRow = (entry: CodeModeCallEntry, theme: Theme, animationFrame: number): string => {
  const { symbol, color } =
    entry.status === "running"
      ? { symbol: brailleSpinnerFrame(animationFrame), color: "warning" as const }
      : ACTIVITY_SYMBOLS[entry.status];
  const icon = nestedToolIcon(entry.tool);
  const toolPrefix = icon === undefined ? "" : `${theme.fg("toolTitle", icon)} `;
  const label = entry.activity ?? describeNestedActivity(entry.tool, undefined);
  const sanitized = truncateDisplay(sanitizeTerminalLine(label), MAX_INTENT_LENGTH);
  const duration =
    entry.durationMs === undefined
      ? ""
      : theme.fg("muted", ` · ${formatCallDuration(entry.durationMs)}`);
  return `${theme.fg(color, symbol)} ${toolPrefix}${theme.fg("toolOutput", sanitized)}${duration}`;
};

const footerLine = (
  details: CodeModeRenderDetails,
  isPartial: boolean,
  isError: boolean,
  theme: Theme,
): string => {
  const { total, queued, running, succeeded, failed, cancelled } = details.counts;
  const settled = succeeded + failed + cancelled;
  const summary = [
    succeeded > 0 ? `${succeeded} succeeded` : undefined,
    failed > 0 ? `${failed} failed` : undefined,
    running > 0 ? `${running} running` : undefined,
    queued > 0 ? `${queued} queued` : undefined,
    cancelled > 0 ? `${cancelled} cancelled` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
  const status = details.cancelled
    ? `Cancelled${summary.length === 0 ? "" : ` · ${summary}`}`
    : isPartial
      ? total === 0
        ? "Starting…"
        : `${settled} of ${total} settled${summary.length === 0 ? "" : ` · ${summary}`}`
      : isError
        ? `Failed${summary.length === 0 ? "" : ` · ${summary}`}`
        : total === 0
          ? "Completed"
          : failed === 0 && cancelled === 0
            ? `${succeeded} operation${succeeded === 1 ? "" : "s"} completed`
            : summary;
  const truncatedNote = details.truncated ? " · output truncated" : "";
  return theme.fg("muted", `${status}${truncatedNote}`);
};

const coloredLines = (text: string, color: "error" | "toolOutput", theme: Theme): string =>
  text
    .split("\n")
    .map((line) => theme.fg(color, line))
    .join("\n");

const outputSection = (
  result: AgentToolResult<unknown>,
  details: CodeModeRenderDetails,
  isError: boolean,
  theme: Theme,
): ReadonlyArray<Component> => {
  const raw = textContentOf(result);
  if (raw.length === 0) return [];
  const color = isError ? "error" : "toolOutput";
  const components: Component[] = [new Text(theme.fg("muted", isError ? "Error" : "Output"), 0, 0)];
  const fields =
    !isError && details.outputKind === "structured"
      ? projectStructuredCodeModeOutput(raw)
      : undefined;
  if (fields === undefined) {
    components.push(new Text(coloredLines(codeModeOutputText(raw), color, theme), 0, 0));
    return components;
  }
  for (const field of fields) {
    components.push(new Text(theme.fg("muted", field.label), 0, 0));
    components.push(new Text(coloredLines(field.body, color, theme), 0, 0));
  }
  return components;
};

/**
 * Collapsed hint pointing at the hidden output/error: names the currently configured
 * `app.tools.expand` key(s) when bound (`▸ output · ctrl+o expand`, multiple keys joined
 * with `/`) and stays keyless when unbound (`▸ output · expand`). Reading the global TUI
 * keybindings accessor is a read-only presentation boundary, matching the
 * `pi-code-previews` and `pi-background-terminals` hints.
 */
const expandHintLine = (isError: boolean, theme: Theme): string => {
  let keys = "";
  try {
    keys = getKeybindings()
      .getKeys("app.tools.expand")
      .slice(0, 4)
      .map((key) => truncateDisplay(sanitizeTerminalLine(key), 32))
      .filter((key) => key.length > 0)
      .join("/");
  } catch {
    // Renderer-only host metadata is optional; never surrender the whole custom result renderer.
  }
  const label = keys.length === 0 ? "expand" : `${keys} expand`;
  return theme.fg("dim", `▸ ${isError ? "error" : "output"} · ${label}`);
};

/**
 * Result projection: activity rows with the standalone built-in tool emoji plus queued `◌`,
 * animated Braille running status, success `✓`, error `✗`, or cancelled `⊘`, a bounded hidden-row marker,
 * and an accurate status footer. Raw output stays hidden
 * while collapsed and appears complete (sanitized) under an `Output`/`Error` label when
 * expanded; partial snapshots never surface their placeholder progress text.
 */
const renderCodeModeToolResultUnsafe = (
  result: AgentToolResult<unknown>,
  options: Pick<ToolRenderResultOptions, "isPartial">,
  theme: Theme,
  context: CodeModeRenderContext | undefined,
  animationFrame: number,
): Component => {
  const details = decodeCodeModeRenderDetails(result.details);
  const isError = context?.isError === true;
  const expanded = context?.expanded === true;
  const container = new Container();
  const hidden = details.totalToolCalls - details.toolCalls.length;
  if (hidden > 0 && details.hasExactCounts) {
    container.addChild(new Text(theme.fg("dim", `+${hidden} earlier`), 0, 0));
  }
  for (const entry of details.toolCalls) {
    container.addChild(new Text(activityRow(entry, theme, animationFrame), 0, 0));
  }
  if (hidden > 0 && !details.hasExactCounts) {
    container.addChild(new Text(theme.fg("dim", `+${hidden} more`), 0, 0));
  }
  container.addChild(new Text(footerLine(details, options.isPartial, isError, theme), 0, 0));
  if (options.isPartial) return container;
  if (expanded) {
    for (const component of outputSection(result, details, isError, theme))
      container.addChild(component);
    return container;
  }
  if (stripTerminalControls(textContentOf(result)).length > 0) {
    container.addChild(new Text(expandHintLine(isError, theme), 0, 0));
  }
  return container;
};

const emergencyResultText = (result: AgentToolResult<unknown>): string => {
  try {
    return codeModeOutputText(textContentOf(result));
  } catch {
    return "";
  }
};

/**
 * A custom renderer must not throw into Pi: Pi silently replaces it with an unframed generic
 * text fallback, which can expose enormous escaped JSON. Keep a plain, dependency-light last
 * resort so optional theme/keybinding/persisted-detail failures retain Code Mode semantics.
 */
export const renderCodeModeToolResult = (
  result: AgentToolResult<unknown>,
  options: Pick<ToolRenderResultOptions, "isPartial">,
  theme: Theme,
  context: CodeModeRenderContext | undefined,
  animationFrame = 0,
): Component => {
  try {
    return renderCodeModeToolResultUnsafe(result, options, theme, context, animationFrame);
  } catch {
    const isError = context?.isError === true;
    const expanded = context?.expanded === true;
    const output = emergencyResultText(result);
    const container = new Container();
    container.addChild(
      new Text(
        options.isPartial
          ? "Code Mode running"
          : isError
            ? "Code Mode failed"
            : "Code Mode completed",
        0,
        0,
      ),
    );
    if (options.isPartial || output.length === 0) return container;
    if (!expanded) {
      container.addChild(new Text(`▸ ${isError ? "error" : "output"} · expand`, 0, 0));
      return container;
    }
    container.addChild(new Text(isError ? "Error" : "Output", 0, 0));
    container.addChild(new Text(output, 0, 0));
    return container;
  }
};
