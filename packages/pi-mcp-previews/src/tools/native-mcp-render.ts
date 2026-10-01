import type {
  AgentToolResult,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import { countLabel, invokeHostCallback, sanitizeDiagnosticContent } from "pi-cosmic-core";
import { clipToWidth } from "pi-cosmic-ui/manager";
import {
  renderExpansionAffordance,
  renderToolHeader,
  toolRunningLine,
  toolStatusLine,
} from "pi-cosmic-ui/tool";
import {
  compactPlainText,
  expandedSection,
  previewIssuesSlot,
  getCodePreviewAnimationFrame,
  escapeControlChars,
  withCodePreviewShell,
  getFallbackResultText,
  type CompactAnimationScheduler,
} from "pi-code-previews";
import {
  nativeMcpEvidence,
  nativeMcpHasRecoverableClipping,
  nativeMcpProgress,
  nativeMcpSummary,
} from "./native-mcp-summary";
import { nativeMcpHeading, nativeMcpIdentity } from "./native-mcp-subject";

/** Heading name for every native MCP row. The registered tool name stays unchanged. */
const DISPLAY_NAME = "mcp";
const PREVIEW_LINES = 5;
const ARGUMENT_PREVIEW_CHARS = 1000;

type Context = Parameters<NonNullable<ToolDefinition<any, any, any>["renderCall"]>>[2];

/** Content survives a host theme that fails while building or drawing it. */
function safeContent(build: () => Component, raw: string, maxRows?: number): Component {
  const plain = escapeControlChars(raw);
  const fallback: Component =
    maxRows === undefined
      ? new Text(plain, 0, 0)
      : {
          render: (width) =>
            plain
              .split("\n")
              .slice(0, maxRows)
              .map((line) => clipToWidth(line, width)),
          invalidate() {},
        };
  let body: Component;
  try {
    body = build();
  } catch {
    return fallback;
  }
  let failed = false;
  return {
    render(width) {
      if (!failed) {
        try {
          return body.render(width);
        } catch {
          failed = true;
        }
      }
      return fallback.render(width);
    },
    invalidate() {
      if (!failed) {
        try {
          body.invalidate();
        } catch {
          failed = true;
        }
      }
      fallback.invalidate();
    },
  };
}

/** Exact arguments as JSON; empty when there are none. JSON escapes control characters. */
function argumentsJson<Args>(args: Args, space?: number): string {
  return invokeHostCallback(() => {
    if (!Predicate.isObject(args) || Object.keys(args).length === 0) return "";
    return JSON.stringify(args, null, space) ?? "";
  }, "");
}

function textBlock(theme: Theme, text: string, color: "toolOutput" | "error" | "muted"): Text {
  return new Text(
    compactPlainText(text)
      .split("\n")
      .map((line) => theme.fg(color, line))
      .join("\n"),
    0,
    0,
  );
}

/** Every argument in full, including those the heading already names. */
function renderArguments<Args>(args: Args, theme: Theme): Component {
  const json = argumentsJson(args, 2);
  if (!json) return new Container();
  return safeContent(
    () => expandedSection(theme, "Arguments", textBlock(theme, json, "toolOutput")),
    `Arguments\n${json}`,
  );
}

/**
 * All native text, including recovery notes and saved-output paths, under one label. Pi draws
 * native images; the shared fallback lists them when they cannot be shown.
 */
function renderOutput(
  result: AgentToolResult<unknown>,
  _options: ToolRenderResultOptions,
  theme: Theme,
  context: Context,
): Component {
  const raw = getFallbackResultText(result.content, context.showImages);
  return safeContent(() => {
    const body = new Container();
    const saved = nativeMcpEvidence(result.details)?.fullOutputPath;
    if (saved && !raw.includes(saved))
      body.addChild(
        expandedSection(
          theme,
          "Saved output",
          textBlock(theme, sanitizeDiagnosticContent(saved), "muted"),
        ),
      );
    if (raw)
      body.addChild(
        expandedSection(
          theme,
          context.isPartial ? "Progress" : context.isError ? "Error" : "Output",
          textBlock(theme, raw, context.isError ? "error" : "toolOutput"),
        ),
      );
    return body;
  }, raw);
}

/** The latest progress message, or the shared running line, animated by the shell's owner. */
function renderProgress(
  result: AgentToolResult<unknown>,
  theme: Theme,
  context: Context,
): Component {
  const progress = nativeMcpProgress(result);
  return safeContent(
    () => ({
      render(width) {
        const frame = getCodePreviewAnimationFrame(context);
        const line = progress
          ? toolStatusLine(theme, "running", progress, frame)
          : toolRunningLine(theme, frame);
        return [clipToWidth(line, width)];
      },
      invalidate() {},
    }),
    progress || "Running…",
    1,
  );
}

/** At most five clipped output lines, then how many more expansion shows. */
function renderOutputPreview(
  result: AgentToolResult<unknown>,
  theme: Theme,
  context: Context,
): Component {
  const raw = getFallbackResultText(result.content, context.showImages).trim();
  if (!raw) return new Container();
  const lines = compactPlainText(raw).split("\n");
  const shown = lines.slice(0, PREVIEW_LINES);
  const hidden = lines.length - shown.length;
  const color = context.isError ? "error" : "toolOutput";
  return safeContent(
    () => ({
      render(width) {
        const rows = shown.map((line) => clipToWidth(theme.fg(color, line), width));
        if (hidden > 0)
          rows.push(
            clipToWidth(
              renderExpansionAffordance(countLabel(hidden, "more line"), false, theme),
              width,
              "",
            ),
          );
        return rows;
      },
      invalidate() {},
    }),
    [...shown, ...(hidden > 0 ? [countLabel(hidden, "more line")] : [])].join("\n"),
    PREVIEW_LINES + 1,
  );
}

/**
 * Decorate one fresh native MCP definition: a dynamic `mcp__…` tool or one of the
 * `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource` tools. Rendering
 * only: the copy keeps every other property, including `execute`, schemas, annotations,
 * exposure, namespace, and results. Load trusted settings first; the shell captures its mode.
 */
export function styleNativeMcp(
  definition: ToolDefinition<any, any, any>,
  scheduleAnimation?: CompactAnimationScheduler | undefined,
): ToolDefinition<any, any, any> {
  const identity = nativeMcpIdentity(definition);
  const renderCall: NonNullable<ToolDefinition<any, any, any>["renderCall"]> = (
    args,
    theme,
    context,
  ) => {
    const { action, subject } = nativeMcpHeading(identity, args);
    const subtitle = [action, subject].filter(Boolean).join(" ");
    const json = identity.kind === "tool" && !context.expanded ? argumentsJson(args) : "";
    const preview =
      json.length > ARGUMENT_PREVIEW_CHARS ? `${json.slice(0, ARGUMENT_PREVIEW_CHARS)}…` : json;
    return safeContent(
      () => {
        // Style before placing the issue slot: a theme failure must leave shared issues visible.
        const previewLine = preview ? theme.fg("muted", compactPlainText(preview)) : "";
        const body = new Container();
        body.addChild(new Text(renderToolHeader({ title: DISPLAY_NAME, subtitle }, theme), 0, 0));
        body.addChild(previewIssuesSlot(context));
        if (context.expanded) body.addChild(renderArguments(args, theme));
        else if (preview)
          body.addChild({
            render: (width) => [clipToWidth(previewLine, width)],
            invalidate() {},
          });
        return body;
      },
      [`${DISPLAY_NAME} ${subtitle}`, context.expanded ? argumentsJson(args, 2) : preview]
        .filter(Boolean)
        .join("\n"),
      context.expanded ? undefined : 2,
    );
  };
  const renderResult: NonNullable<ToolDefinition<any, any, any>["renderResult"]> = (
    result,
    options,
    theme,
    context,
  ) => {
    if (options.expanded) return renderOutput(result, options, theme, context);
    if (options.isPartial) return renderProgress(result, theme, context);
    if (!context.isError && nativeMcpHasRecoverableClipping(identity, result))
      return safeContent(
        () => new Text(renderExpansionAffordance("output", false, theme), 0, 0),
        "Output · expand",
        1,
      );
    return renderOutputPreview(result, theme, context);
  };
  return withCodePreviewShell(
    { ...definition, renderCall, renderResult },
    {
      preserveSelfShell: false,
      displayName: DISPLAY_NAME,
      compactSummary: nativeMcpSummary(identity),
      animateProgress: true,
      scheduleAnimation,
      expandedContent: {
        renderCall: (args, theme) => renderArguments(args, theme),
        renderResult: renderOutput,
      },
    },
  );
}
