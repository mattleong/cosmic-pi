import type {
  AgentToolResult,
  Theme,
  ToolInfo,
  ToolRenderers,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Rec from "effect/Record";
import { countLabel, invokeHostCallback, sanitizeDiagnosticContent } from "pi-cosmic-core";
import { clipToWidth } from "pi-cosmic-ui/manager";
import {
  renderExpansionAffordance,
  renderToolHeader,
  toolRunningLine,
  toolStatusLine,
} from "pi-cosmic-ui/tool";
import type { CodePreviewRendererAppearance } from "../application/renderer-contract";
import { compactPlainText } from "../preview/compact-row";
import { expandedSection } from "../preview/expanded-section";
import { previewIssuesSlot } from "../preview/preview-issues";
import { getCodePreviewAnimationFrame } from "../preview/tool-timing";
import { hostContainer, type HostContainer } from "../shared/untrusted-value";
import { escapeControlChars } from "../shared/terminal-text";
import { withCodePreviewRenderers } from "./cooperative-tools";
import { getFallbackResultText } from "./data/results";
import type {
  RenderCall,
  RendererState,
  RenderResult,
  ToolRenderContext,
} from "./renderers/shared/types";
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

const DISPLAY_NAME = "mcp";
const PREVIEW_LINES = 5;
const ARGUMENT_PREVIEW_CHARS = 1000;

type Context = ToolRenderContext<RendererState, unknown>;
const unstyled: Pick<Theme, "fg"> = { fg: (_color, text) => text };

function argumentsJson(args: HostContainer | undefined, space?: number): string {
  return invokeHostCallback(() => {
    if (!Predicate.isObject(args) || Rec.keys(args).length === 0) return "";
    return JSON.stringify(args, null, space) ?? "";
  }, "");
}

function textBlock(theme: Theme, text: string, color: "toolOutput" | "error" | "muted"): Text {
  return new Text(
    Arr.join(
      Arr.map(Str.split(compactPlainText(text), "\n"), (line) => theme.fg(color, line)),
      "\n",
    ),
    0,
    0,
  );
}

function renderArguments(args: HostContainer | undefined, theme: Theme): Component {
  const json = argumentsJson(args, 2);
  if (!json) return new Container();
  return safeContent(
    () => expandedSection(theme, "Arguments", textBlock(theme, json, "toolOutput")),
    `Arguments\n${json}`,
  );
}

function renderOutput(
  result: AgentToolResult<unknown>,
  _options: ToolRenderResultOptions,
  theme: Theme,
  context: Context,
): Component {
  const raw = getFallbackResultText(result.content, context.showImages);
  const path = nativeMcpEvidence(hostContainer(result.details))?.fullOutputPath;
  const saved =
    path && !Fn.pipe(raw, Str.includes(path)) ? sanitizeDiagnosticContent(path) : undefined;
  const recovery = saved === undefined ? "" : `Saved output\n${saved}`;
  return safeContent(
    () => {
      const body = new Container();
      if (saved !== undefined)
        body.addChild(expandedSection(theme, "Saved output", textBlock(theme, saved, "muted")));
      if (raw)
        body.addChild(
          expandedSection(
            theme,
            context.isPartial ? "Progress" : context.isError ? "Error" : "Output",
            textBlock(theme, raw, context.isError ? "error" : "toolOutput"),
          ),
        );
      return body;
    },
    Arr.join(Arr.filter([recovery, raw], Str.isNonEmpty), "\n"),
  );
}

function renderProgress(
  result: AgentToolResult<unknown>,
  theme: Theme,
  state: RendererState,
): Component {
  const progress = nativeMcpProgress(result);
  return safeContent(
    () => ({
      render(width) {
        const frame = getCodePreviewAnimationFrame({ state });
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

function renderOutputPreview(
  result: AgentToolResult<unknown>,
  theme: Theme,
  context: Context,
): Component {
  const raw = Str.trim(getFallbackResultText(result.content, context.showImages));
  if (!raw) return new Container();
  const lines = Str.split(compactPlainText(raw), "\n");
  const color = context.isError ? "error" : "toolOutput";
  const preview = (style: Pick<Theme, "fg">): Component => {
    let wrapped: { readonly width: number; readonly rows: readonly string[] } | undefined;
    return {
      render(width) {
        if (width <= 0) return [];
        if (wrapped?.width !== width)
          wrapped = { width, rows: Arr.flatMap(lines, (line) => wrapTextWithAnsi(line, width)) };
        const rows = Arr.map(wrapped.rows.slice(0, PREVIEW_LINES), (row) => style.fg(color, row));
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

export function createNativeMcpRenderers(
  name: string,
  tool: Pick<ToolInfo, "namespace"> | undefined,
  downstream: ToolRenderers | undefined,
  appearance: CodePreviewRendererAppearance,
): ToolRenderers {
  const identity = nativeMcpIdentity(name, tool);
  const nativeCall = identity.kind === "tool" ? downstream?.renderCall : undefined;
  const nativeComponents = new WeakSet<Component>();
  const receipts = new WeakMap<object, NativeMcpEvidence>();
  const recordReceipt = (result: AgentToolResult<unknown>, context: Context): void => {
    const receipt = nativeMcpReceipt(identity, result, hostContainer(context.args));
    if (receipt && Predicate.isObject(context.state)) receipts.set(context.state, receipt);
  };
  const subtitle = (state: RendererState, args: HostContainer | undefined): string => {
    const receipt = Predicate.isObject(state) ? receipts.get(state) : undefined;
    const { action, subject } = nativeMcpHeading(identity, args, receipt);
    return Arr.join(Arr.filter([action, subject], Str.isNonEmpty), " ");
  };
  const heading = (
    theme: Theme,
    state: RendererState,
    args: HostContainer | undefined,
  ): Component => {
    const text = new Text("", 0, 0);
    return {
      render(width) {
        const current = subtitle(state, args);
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
  const renderCall: RenderCall<unknown, RendererState> = (args, theme, context) => {
    if (nativeCall && !context.expanded) {
      const lastComponent =
        context.lastComponent && nativeComponents.has(context.lastComponent)
          ? context.lastComponent
          : undefined;
      const body = nativeCall(args, theme, { ...context, lastComponent });
      nativeComponents.add(body);
      return body;
    }
    const input = hostContainer(args);
    const contextArgs = hostContainer(context.args);
    const json = identity.kind === "tool" && !context.expanded ? argumentsJson(input) : "";
    const preview =
      json.length > ARGUMENT_PREVIEW_CHARS
        ? `${Fn.pipe(json, Str.slice(0, ARGUMENT_PREVIEW_CHARS))}…`
        : json;
    const raw = Arr.join(
      Arr.filter(
        [
          `${DISPLAY_NAME} ${subtitle(context.state, contextArgs)}`,
          context.expanded ? argumentsJson(input, 2) : preview,
        ],
        Str.isNonEmpty,
      ),
      "\n",
    );
    return safeContent(
      () => {
        const previewLine = preview ? theme.fg("muted", compactPlainText(preview)) : "";
        const body = new Container();
        body.addChild(heading(theme, context.state, contextArgs));
        body.addChild(previewIssuesSlot(context));
        if (context.expanded) body.addChild(renderArguments(input, theme));
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
  const renderExpandedOutput: RenderResult<unknown, unknown, RendererState> = (
    result,
    options,
    theme,
    context,
  ) => {
    recordReceipt(result, context);
    return renderOutput(result, options, theme, context);
  };
  const renderResult: RenderResult<unknown, unknown, RendererState> = (
    result,
    options,
    theme,
    context,
  ) => {
    if (options.expanded) return renderExpandedOutput(result, options, theme, context);
    recordReceipt(result, context);
    if (options.isPartial) return renderProgress(result, theme, context.state);
    if (
      !context.isError &&
      nativeMcpHasRecoverableClipping(identity, result, hostContainer(context.args))
    )
      return safeContent(
        () => new Text(renderExpansionAffordance("output", false, theme), 0, 0),
        plainRows("Output · expand", 1),
      );
    return renderOutputPreview(result, theme, context);
  };
  return withCodePreviewRenderers(
    { name },
    { renderCall, renderResult },
    {
      ...appearance,
      displayName: DISPLAY_NAME,
      compactSummary: nativeMcpSummary(identity),
      animateProgress: true,
      expandedContent: {
        renderCall: (args, theme) => renderArguments(hostContainer(args), theme),
        renderResult: renderExpandedOutput,
      },
    },
  );
}
