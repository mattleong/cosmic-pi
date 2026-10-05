import type {
  AgentToolResult,
  Theme,
  ToolRenderers,
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
import type {
  CodePreviewRendererAppearance,
  PreviewToolInfo,
} from "../application/renderer-contract";
import { compactPlainText } from "../preview/compact-row";
import { expandedSection } from "../preview/expanded-section";
import { previewIssuesSlot } from "../preview/preview-issues";
import { getCodePreviewAnimationFrame } from "../preview/tool-timing";
import { escapeControlChars } from "../shared/terminal-text";
import { withCodePreviewRenderers, type CodePreviewShellOptions } from "./cooperative-tools";
import { getFallbackResultText } from "./data/results";
import type { CompactAnimationScheduler } from "./compact-summary";
import type { ToolRenderContext } from "./renderers/shared/types";
import {
  nativeMcpEvidence,
  nativeMcpHasRecoverableClipping,
  nativeMcpProgress,
  nativeMcpSummary,
} from "./native-mcp-summary";
import { nativeMcpHeading } from "./native-mcp-subject";
import { nativeMcpIdentity } from "./native-mcp-identity";

/** Heading name for every native MCP row. The registered tool name stays unchanged. */
const DISPLAY_NAME = "mcp";
const PREVIEW_LINES = 5;
const ARGUMENT_PREVIEW_CHARS = 1000;

type Context = ToolRenderContext<any, any>;

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
  const saved = nativeMcpEvidence(result.details)?.fullOutputPath;
  const recovery =
    saved && !raw.includes(saved) ? `Saved output\n${sanitizeDiagnosticContent(saved)}` : "";
  return safeContent(() => {
    const body = new Container();
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
  }, [recovery, raw].filter(Boolean).join("\n"));
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

/** Presentation only. Pi keeps its manager, execution, schemas, exposure and permissions. */
export function createNativeMcpRenderers(
  name: string,
  tool: Pick<PreviewToolInfo, "namespace"> | undefined,
  downstream: ToolRenderers | undefined,
  scheduleAnimation: CompactAnimationScheduler,
  appearance: Partial<
    Pick<CodePreviewRendererAppearance, "selfShell" | "mode" | "collapsedStyle">
  > = {},
): ToolRenderers {
  const identity = nativeMcpIdentity(name, tool);
  // Without an exact public remote identity, keep the entire native call (including its label
  // and any additional content). next() is only a renderer set, never a tool definition.
  const nativeCall = identity.kind === "tool" ? downstream?.renderCall : undefined;
  // The native callback updates its own prior Text, never a combined shell or Container.
  const nativeComponents = new WeakMap<Component, Component>();
  const nativeContext = (context: Context): Context => ({
    ...context,
    lastComponent: context.lastComponent ? nativeComponents.get(context.lastComponent) : undefined,
  });
  const expandedCall: NonNullable<ToolRenderers["renderCall"]> = (args, theme, context) => {
    let nativeBody: Component | undefined;
    const component = safeContent(
      () => {
        const body = new Container();
        if (nativeCall) {
          nativeBody = nativeCall(args, theme, nativeContext(context));
          body.addChild(nativeBody);
        }
        body.addChild(renderArguments(args, theme));
        return body;
      },
      `${name}\n${argumentsJson(args, 2)}`,
    );
    if (nativeBody) nativeComponents.set(component, nativeBody);
    return component;
  };
  const renderCall: NonNullable<ToolRenderers["renderCall"]> = (args, theme, context) => {
    if (nativeCall) {
      if (context.expanded) return expandedCall(args, theme, context);
      const body = nativeCall(args, theme, nativeContext(context));
      nativeComponents.set(body, body);
      return body;
    }
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
  const renderResult: NonNullable<ToolRenderers["renderResult"]> = (
    result,
    options,
    theme,
    context,
  ) => {
    if (options.expanded) return renderOutput(result, options, theme, context);
    if (options.isPartial) return renderProgress(result, theme, context);
    if (!context.isError && nativeMcpHasRecoverableClipping(identity, result, context.args))
      return safeContent(
        () => new Text(renderExpansionAffordance("output", false, theme), 0, 0),
        "Output · expand",
        1,
      );
    return renderOutputPreview(result, theme, context);
  };
  const options: CodePreviewShellOptions = {
    preserveSelfShell: false,
    displayName: DISPLAY_NAME,
    compactSummary: nativeMcpSummary(identity),
    animateProgress: true,
    scheduleAnimation,
    expandedContent: { renderCall: expandedCall, renderResult: renderOutput },
  };
  if (appearance.selfShell !== undefined) options.selfShell = appearance.selfShell;
  if (appearance.mode !== undefined) options.mode = appearance.mode;
  if (appearance.collapsedStyle !== undefined) options.collapsedStyle = appearance.collapsedStyle;
  return withCodePreviewRenderers({ name }, { renderCall, renderResult }, options);
}
