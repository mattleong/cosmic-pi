import type {
  AgentToolResult,
  Theme,
  ToolRenderers,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
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
  nativeMcpReceipt,
  nativeMcpSummary,
  type NativeMcpEvidence,
} from "./native-mcp-summary";
import { nativeMcpHeading } from "./native-mcp-subject";
import { nativeMcpIdentity } from "./native-mcp-identity";
import { plainRows, safeContent } from "./native-safe-content";

/** Heading name for every native MCP row. The registered tool name stays unchanged. */
const DISPLAY_NAME = "mcp";
const PREVIEW_LINES = 5;
const ARGUMENT_PREVIEW_CHARS = 1000;

type Context = ToolRenderContext<any, any>;
const unstyled: Pick<Theme, "fg"> = { fg: (_color, text) => text };

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
    plainRows(progress || "Running…", 1),
  );
}

/**
 * At most five output rows wrapped at the render width, since MCP results are often one long
 * JSON line, then how many more rows expansion shows.
 */
function renderOutputPreview(
  result: AgentToolResult<unknown>,
  theme: Theme,
  context: Context,
): Component {
  const raw = getFallbackResultText(result.content, context.showImages).trim();
  if (!raw) return new Container();
  const lines = compactPlainText(raw).split("\n");
  const color = context.isError ? "error" : "toolOutput";
  const preview = (style: Pick<Theme, "fg">): Component => {
    let wrapped: { readonly width: number; readonly rows: readonly string[] } | undefined;
    return {
      render(width) {
        if (width <= 0) return [];
        if (wrapped?.width !== width)
          wrapped = { width, rows: lines.flatMap((line) => wrapTextWithAnsi(line, width)) };
        const rows = wrapped.rows.slice(0, PREVIEW_LINES).map((row) => style.fg(color, row));
        const hidden = wrapped.rows.length - rows.length;
        if (hidden > 0)
          rows.push(
            clipToWidth(
              renderExpansionAffordance(countLabel(hidden, "more line"), false, style),
              width,
              "",
            ),
          );
        return rows;
      },
      invalidate() {
        wrapped = undefined;
      },
    };
  };
  return safeContent(() => preview(theme), preview(unstyled));
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
  // Without an exact public remote identity, a collapsed call keeps the entire native call
  // (including its label and any additional content). next() is only a renderer set, never a
  // tool definition. Expanded calls show the shared heading and each argument once.
  const nativeCall = identity.kind === "tool" ? downstream?.renderCall : undefined;
  // The native callback updates its own prior component, never one of ours.
  const nativeComponents = new WeakSet<Component>();
  // Pi builds the call before its result but draws both afterwards, so the heading reads the
  // row's latest matching receipt when drawn, naming the server and tool as compact rows do.
  const receipts = new WeakMap<object, NativeMcpEvidence>();
  const recordReceipt = (result: AgentToolResult<unknown>, context: Context): void => {
    const receipt = nativeMcpReceipt(identity, result, context.args);
    if (receipt && Predicate.isObject(context.state)) receipts.set(context.state, receipt);
  };
  const subtitle = (context: Context): string => {
    const receipt = Predicate.isObject(context.state) ? receipts.get(context.state) : undefined;
    const { action, subject } = nativeMcpHeading(identity, context.args, receipt);
    return [action, subject].filter(Boolean).join(" ");
  };
  /** Drawn plain if the host theme fails, so the issue lines placed beneath it stay visible. */
  const heading = (theme: Theme, context: Context): Component => {
    const text = new Text("", 0, 0);
    return {
      render(width) {
        const current = subtitle(context);
        try {
          text.setText(renderToolHeader({ title: DISPLAY_NAME, subtitle: current }, theme));
        } catch {
          text.setText(escapeControlChars(`${DISPLAY_NAME} ${current}`));
        }
        return text.render(width);
      },
      invalidate() {
        text.invalidate();
      },
    };
  };
  const renderCall: NonNullable<ToolRenderers["renderCall"]> = (args, theme, context) => {
    if (nativeCall && !context.expanded) {
      const lastComponent =
        context.lastComponent && nativeComponents.has(context.lastComponent)
          ? context.lastComponent
          : undefined;
      const body = nativeCall(args, theme, { ...context, lastComponent });
      nativeComponents.add(body);
      return body;
    }
    const json = identity.kind === "tool" && !context.expanded ? argumentsJson(args) : "";
    const preview =
      json.length > ARGUMENT_PREVIEW_CHARS ? `${json.slice(0, ARGUMENT_PREVIEW_CHARS)}…` : json;
    const raw = [
      `${DISPLAY_NAME} ${subtitle(context)}`,
      context.expanded ? argumentsJson(args, 2) : preview,
    ]
      .filter(Boolean)
      .join("\n");
    return safeContent(
      () => {
        // Style before placing the issue slot: a theme failure must leave shared issues visible.
        const previewLine = preview ? theme.fg("muted", compactPlainText(preview)) : "";
        const body = new Container();
        body.addChild(heading(theme, context));
        body.addChild(previewIssuesSlot(context));
        if (context.expanded) body.addChild(renderArguments(args, theme));
        else if (preview)
          body.addChild({
            render: (width) => [clipToWidth(previewLine, width)],
            invalidate() {},
          });
        return body;
      },
      context.expanded ? raw : plainRows(raw, 2),
    );
  };
  const renderExpandedOutput: NonNullable<ToolRenderers["renderResult"]> = (
    result,
    options,
    theme,
    context,
  ) => {
    recordReceipt(result, context);
    return renderOutput(result, options, theme, context);
  };
  const renderResult: NonNullable<ToolRenderers["renderResult"]> = (
    result,
    options,
    theme,
    context,
  ) => {
    if (options.expanded) return renderExpandedOutput(result, options, theme, context);
    recordReceipt(result, context);
    if (options.isPartial) return renderProgress(result, theme, context);
    if (!context.isError && nativeMcpHasRecoverableClipping(identity, result, context.args))
      return safeContent(
        () => new Text(renderExpansionAffordance("output", false, theme), 0, 0),
        plainRows("Output · expand", 1),
      );
    return renderOutputPreview(result, theme, context);
  };
  const options: CodePreviewShellOptions = {
    preserveSelfShell: false,
    displayName: DISPLAY_NAME,
    compactSummary: nativeMcpSummary(identity),
    animateProgress: true,
    scheduleAnimation,
    expandedContent: {
      renderCall: (args, theme) => renderArguments(args, theme),
      renderResult: renderExpandedOutput,
    },
  };
  if (appearance.selfShell !== undefined) options.selfShell = appearance.selfShell;
  if (appearance.mode !== undefined) options.mode = appearance.mode;
  if (appearance.collapsedStyle !== undefined) options.collapsedStyle = appearance.collapsedStyle;
  return withCodePreviewRenderers({ name }, { renderCall, renderResult }, options);
}
