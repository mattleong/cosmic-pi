/** Pure, terminal-safe TUI presentation for `code_mode`. */
import * as Predicate from "effect/Predicate";

import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import * as codePreviews from "pi-code-previews";
import { sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core";
import * as Schema from "effect/Schema";
import {
  managerActivityColor,
  managerActivityGlyph,
  type ManagerActivityKind,
} from "pi-cosmic-ui/manager";
import { expandKeyHint, renderExpansionAffordance, renderToolHeader } from "pi-cosmic-ui/tool";
import { codeModeVisibleNotices } from "./notices.ts";
import { CODE_MODE_INTEGER_BOUNDS } from "../config/schema.ts";
import {
  decodeOption,
  MAX_INTENT_LENGTH,
  truncateDisplay,
  type CodeModeCallEntry,
} from "../tools/format.ts";
import { renderExpandedCodeModeResult, type ExpandedPresentation } from "./expanded-result.ts";
import { formatCodeModeProgram } from "./program-source.ts";
import { codeModeOutputText } from "./result-output.ts";
import { addCodeModeSection } from "./sections.ts";
import { codeModeReadRequest, renderCodeModeResultRead } from "./result-read-renderer.ts";
import { decodeCodeModeRenderDetails, type CodeModeRenderDetails } from "./tool-render-details.ts";

/** Neutral headline when the model provided no usable intent. */
const CODE_MODE_FALLBACK_INTENT = "Tool orchestration";
const visibleNotices = (details: CodeModeRenderDetails, expanded: boolean): readonly string[] =>
  codeModeVisibleNotices(details, expanded).map((notice) => notice.text);

const MAX_SOURCE_DISPLAY_LENGTH = CODE_MODE_INTEGER_BOUNDS.maxSourceBytes.maximum;

export const describeCodeModeIntent = <Intent>(intent: Intent): string => {
  if (!Predicate.isString(intent)) return CODE_MODE_FALLBACK_INTENT;
  const sanitized = sanitizeTerminalLine(intent);
  if (sanitized.length === 0) return CODE_MODE_FALLBACK_INTENT;
  return truncateDisplay(sanitized, MAX_INTENT_LENGTH);
};

const TextContentPartInputSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
const CodeModeArgumentsInputSchema = Schema.Struct({
  intent: Schema.optional(Schema.Unknown),
  code: Schema.optional(Schema.Unknown),
});

const textContentOf = (result: AgentToolResult<unknown>): string => {
  const content: unknown = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const record = decodeOption(TextContentPartInputSchema, part);
      return record === undefined ? [] : [record.text];
    })
    .join("\n");
};

const intentHeadline = <Args>(args: Args, theme: Theme): string => {
  const intent = describeCodeModeIntent(decodeOption(CodeModeArgumentsInputSchema, args)?.intent);
  return renderToolHeader({ title: "Code Mode", subtitle: `· ${intent}` }, theme);
};

export const codeModeSource = <Args>(args: Args): string | undefined => {
  const code = decodeOption(CodeModeArgumentsInputSchema, args)?.code;
  return Predicate.isString(code) ? code : undefined;
};

export interface CodeModeRenderContext {
  readonly expanded: boolean;
  readonly isError?: boolean;
}

export const renderCodeModeToolCall = <Args>(
  args: Args,
  theme: Theme,
  context: CodeModeRenderContext | undefined,
): Component => {
  const read = codeModeReadRequest(args);
  if (read)
    return new Text(
      renderToolHeader(
        {
          title: "Code Mode result.read",
          subtitle: truncateDisplay(sanitizeTerminalLine(read.id), 128),
        },
        theme,
      ),
      0,
      0,
    );
  const header = new Text(intentHeadline(args, theme), 0, 0);
  let expanded = false;
  try {
    expanded = context?.expanded === true;
  } catch {
    // Hostile render context falls back to the collapsed call.
  }
  if (!expanded) return header;
  const container = new Container();
  container.addChild(header);
  const program = addCodeModeSection(container, "Program", theme);
  const source = codeModeSource(args);
  if (source === undefined) {
    program.addChild(new Text(theme.fg("dim", "(program not available)"), 0, 0));
    return container;
  }
  const sanitized = truncateDisplay(
    stripTerminalControls(formatCodeModeProgram(source)),
    MAX_SOURCE_DISPLAY_LENGTH,
  );
  const body = sanitized
    .split("\n")
    .map((line) => theme.fg("toolOutput", line))
    .join("\n");
  program.addChild(new Text(body, 0, 0));
  return container;
};

const ACTIVITY_KINDS = {
  queued: "pending",
  completed: "done",
  error: "failed",
  cancelled: "stopped",
} as const satisfies Readonly<
  Record<Exclude<CodeModeCallEntry["status"], "running">, ManagerActivityKind>
>;

const formatCallDuration = (durationMs: number): string =>
  durationMs < 1_000
    ? `${durationMs}ms`
    : durationMs < 10_000
      ? `${(durationMs / 1_000).toFixed(1)}s`
      : `${Math.round(durationMs / 1_000)}s`;

const nestedToolIcon = (tool: string): string | undefined => {
  if (!tool.startsWith("pi.")) return undefined;
  try {
    const icon = codePreviews.getCodePreviewToolIcon(tool.slice("pi.".length));
    if (!Predicate.isString(icon)) return undefined;
    const sanitized = truncateDisplay(sanitizeTerminalLine(icon), 8);
    return sanitized.length === 0 ? undefined : sanitized;
  } catch {
    return undefined;
  }
};

const activityRow = (entry: CodeModeCallEntry, theme: Theme, animationFrame: number): string => {
  const kind: ManagerActivityKind =
    entry.status === "running" ? "running" : ACTIVITY_KINDS[entry.status];
  const symbol = managerActivityGlyph(kind, animationFrame);
  const color = managerActivityColor(kind);
  const icon = nestedToolIcon(entry.tool);
  const toolPrefix = icon === undefined ? "" : `${theme.fg("toolTitle", icon)} `;
  // Current calls retain one redacted producer heading. Activity is replay-only.
  const subject = entry.compact?.subject ?? entry.subject;
  const label =
    subject === undefined
      ? (entry.activity ?? entry.tool)
      : [entry.tool, entry.compact?.action, subject].filter(Boolean).join(" ");
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

/** Collapsed hint using bounded key labels captured by the host controller. */
const expandHintLine = (
  isError: boolean,
  theme: Theme,
  expandKeys: ReadonlyArray<string>,
): string => {
  return renderExpansionAffordance(
    isError ? "error" : "output",
    false,
    theme,
    expandKeyHint(expandKeys, "expand"),
  );
};

const renderCodeModeToolResultUnsafe = (
  result: AgentToolResult<unknown>,
  details: CodeModeRenderDetails,
  isPartial: boolean,
  theme: Theme,
  context: CodeModeRenderContext,
  animationFrame: number,
  expandKeys: ReadonlyArray<string>,
  presentation: ExpandedPresentation,
): Component => {
  const isError = context?.isError === true;
  const expanded = context?.expanded === true;
  if (expanded)
    return renderExpandedCodeModeResult(
      details,
      textContentOf(result),
      isPartial,
      isError,
      theme,
      animationFrame,
      {
        ...presentation,
        fallbackStatus: presentation.ownsCall ? "" : footerLine(details, isPartial, isError, theme),
        summary: presentation.summary ?? {
          subject: "Tool orchestration",
          counters: [`${details.totalToolCalls} tools`],
          outcome: isError
            ? "error"
            : details.cancelled
              ? "cancelled"
              : details.mcpEvidence?.unknown || details.compactAttention?.incomplete
                ? "uncertain"
                : details.counts.failed || details.truncated
                  ? "warning"
                  : "success",
          notices: codeModeVisibleNotices(details, true),
        },
      },
    );
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
  container.addChild(new Text(footerLine(details, isPartial, isError, theme), 0, 0));
  for (const notice of visibleNotices(details, expanded))
    container.addChild(new Text(sanitizeTerminalLine(notice), 0, 0));
  if (isPartial) return container;
  if (stripTerminalControls(textContentOf(result)).length > 0) {
    container.addChild(new Text(expandHintLine(isError, theme, expandKeys), 0, 0));
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

// Pi's generic fallback can expose unframed JSON, so this renderer always returns a component.
export interface CodeModeResultRender {
  readonly component: Component;
  readonly shouldAnimate: boolean;
}

export const renderCodeModeToolResult = (
  result: AgentToolResult<unknown>,
  options: Pick<ToolRenderResultOptions, "isPartial">,
  theme: Theme,
  context: CodeModeRenderContext | undefined,
  animationFrame = 0,
  expandKeys: ReadonlyArray<string> = [],
  presentation: ExpandedPresentation = {},
): CodeModeResultRender => {
  const guarded = <Value>(read: () => Value): boolean => {
    try {
      return read() === true;
    } catch {
      return false;
    }
  };
  const isPartial = guarded(() => options.isPartial);
  const isError = guarded(() => context?.isError);
  const expanded = guarded(() => context?.expanded);
  if (presentation.readRequest)
    return {
      component: renderCodeModeResultRead(
        emergencyResultText(result),
        presentation.summary,
        isPartial,
        isError,
        expanded,
        theme,
      ),
      shouldAnimate: false,
    };
  let details: CodeModeRenderDetails;
  try {
    const rawDetails = result.details;
    details = decodeCodeModeRenderDetails(rawDetails);
  } catch {
    details = decodeCodeModeRenderDetails(undefined);
  }
  const shouldAnimate = isPartial && details.toolCalls.some((call) => call.status === "running");
  const emergency = (): Component => {
    const output = emergencyResultText(result);
    const component = new Container();
    if (expanded && presentation.ownsCall) {
      component.addChild(new Text("Program", 0, 0));
      component.addChild(
        new Text(
          truncateDisplay(
            stripTerminalControls(
              formatCodeModeProgram(presentation.source ?? "(program not available)"),
            ),
            MAX_SOURCE_DISPLAY_LENGTH,
          ),
          0,
          0,
        ),
      );
    }
    component.addChild(
      new Text(
        isPartial ? "Code Mode running" : isError ? "Code Mode failed" : "Code Mode result",
        0,
        0,
      ),
    );
    if (!isPartial && output.length > 0) {
      if (!expanded)
        component.addChild(new Text(`▸ ${isError ? "error" : "output"} · expand`, 0, 0));
      else {
        component.addChild(new Text(isError ? "Error" : "Output", 0, 0));
        component.addChild(new Text(output, 0, 0));
      }
    }
    for (const notice of new Set([
      ...visibleNotices(details, expanded),
      ...(presentation.summary?.notices
        ?.filter((notice) => expanded || codePreviews.isCompactAttention(notice))
        .map((notice) => notice.text) ?? []),
    ]))
      component.addChild(new Text(stripTerminalControls(notice), 0, 0));
    return component;
  };
  try {
    const component = renderCodeModeToolResultUnsafe(
      result,
      details,
      isPartial,
      theme,
      { isError, expanded },
      animationFrame,
      expandKeys,
      presentation,
    );
    return {
      component: {
        render: (width) => {
          try {
            return component.render(width);
          } catch {
            return emergency().render(width);
          }
        },
        invalidate: () => component.invalidate(),
      },
      shouldAnimate,
    };
  } catch {
    return { component: emergency(), shouldAnimate };
  }
};
