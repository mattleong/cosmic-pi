/** Pure, terminal-safe TUI presentation for `code_mode`. */
import * as Predicate from "effect/Predicate";

import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { renderCompactChildren, type CompactSummary } from "pi-code-previews";
import { invokeHostCallback, sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core";
import * as Schema from "effect/Schema";
import {
  expandKeyHint,
  renderExpansionAffordance,
  renderToolHeader,
  toolRunningLine,
} from "pi-cosmic-ui/tool";
import {
  decodeOption,
  MAX_INTENT_LENGTH,
  truncateDisplay,
  type CodeModeCallEntry,
} from "../tools/format.ts";
import { codeModeCallRows } from "./call-rows.ts";
import { renderExpandedCodeModeResult, renderProgramSection } from "./expanded-result.ts";
import { codeModeOutputText } from "./result-output.ts";
import { codeModeReadRequest, renderCodeModeResultRead } from "./result-read-renderer.ts";
import { decodeCodeModeRenderDetails, type CodeModeRenderDetails } from "./tool-render-details.ts";

/** Neutral headline when the model provided no usable intent. */
const CODE_MODE_FALLBACK_INTENT = "Tool orchestration";

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

export const codeModeSource = <Args>(args: Args): string | undefined => {
  const code = decodeOption(CodeModeArgumentsInputSchema, args)?.code;
  return Predicate.isString(code) ? code : undefined;
};

/** Content-only call slot: the shell supplies the heading and issues above it. */
export const renderCodeModeProgramContent = <Args>(args: Args, theme: Theme): Component =>
  codeModeReadRequest(args) ? new Container() : renderProgramSection(codeModeSource(args), theme);

export interface CodeModeRenderContext {
  readonly expanded: boolean;
  readonly isError?: boolean;
}

/**
 * The original call slot is the heading. Once execution starts, the result slot owns the issues
 * and program; before that, an expanded call shows its program here so it is always reachable.
 */
export const renderCodeModeToolCall = <Args>(
  args: Args,
  theme: Theme,
  context?: { readonly expanded?: boolean; readonly executionStarted?: boolean },
): Component => {
  const read = codeModeReadRequest(args);
  const header = {
    title: "Code Mode",
    subtitle: read
      ? "result.read saved output"
      : describeCodeModeIntent(decodeOption(CodeModeArgumentsInputSchema, args)?.intent),
  };
  const heading = new Text(renderToolHeader(header, theme), 0, 0);
  const awaitingResult = invokeHostCallback(
    () => context?.expanded === true && context.executionStarted !== true,
    false,
  );
  if (read || !awaitingResult) return heading;
  const container = new Container();
  container.addChild(heading);
  container.addChild(renderProgramSection(codeModeSource(args), theme));
  return container;
};

export interface CodeModePresentation {
  /** The shell already renders the heading, the run's issues and the program. */
  readonly contentOnly?: boolean;
  readonly readRequest?: { readonly id: string };
  readonly summary?: CompactSummary | undefined;
  readonly program?: string | undefined;
  readonly timingEnabled?: boolean;
  readonly liveElapsed?: ((call: CodeModeCallEntry) => number | undefined) | undefined;
}

const lines = (render: (width: number) => string[]): Component => ({ render, invalidate() {} });

const renderCodeModeToolResultUnsafe = (
  result: AgentToolResult<unknown>,
  details: CodeModeRenderDetails,
  view: { readonly isPartial: boolean; readonly isError: boolean; readonly expanded: boolean },
  theme: Theme,
  animationFrame: number,
  expandKeys: ReadonlyArray<string>,
  presentation: CodeModePresentation,
): Component => {
  const { isPartial, isError, expanded } = view;
  const raw = textContentOf(result);
  const phase = isPartial ? "running" : "settled";
  const rows =
    presentation.summary?.children?.entries ??
    codeModeCallRows(details, phase, presentation.liveElapsed);
  // The shell shows the run's issues above this slot in both styles.
  if (expanded)
    return renderExpandedCodeModeResult({
      details,
      rows: [...rows],
      raw,
      isPartial,
      isError,
      theme,
      animationFrame,
      timingEnabled: presentation.timingEnabled ?? true,
      contentOnly: presentation.contentOnly === true,
      program: presentation.program,
    });
  const container = new Container();
  if (isPartial && details.counts.total === 0)
    container.addChild(new Text(toolRunningLine(theme, animationFrame), 0, 0));
  // Preview style lists every retained call; compact style keeps the five most relevant.
  container.addChild(
    lines((width) =>
      renderCompactChildren({ total: details.counts.total, entries: rows }, theme, width, {
        animationFrame,
        timingEnabled: presentation.timingEnabled ?? true,
        all: true,
      }),
    ),
  );
  if (!isPartial && stripTerminalControls(raw).length > 0)
    container.addChild(
      new Text(
        renderExpansionAffordance(
          isError ? "error" : "output",
          false,
          theme,
          expandKeyHint(expandKeys, "expand"),
        ),
        0,
        0,
      ),
    );
  return container;
};

const emergencyResultText = (result: AgentToolResult<unknown>): string =>
  invokeHostCallback(() => codeModeOutputText(textContentOf(result)), "");

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
  presentation: CodeModePresentation = {},
): CodeModeResultRender => {
  const guarded = <Value>(read: () => Value): boolean =>
    invokeHostCallback(() => read() === true, false);
  const view = {
    isPartial: guarded(() => options.isPartial),
    isError: guarded(() => context?.isError),
    expanded: guarded(() => context?.expanded),
  };
  if (presentation.readRequest)
    return {
      component: renderCodeModeResultRead(
        emergencyResultText(result),
        presentation.summary,
        view.isPartial,
        view.isError,
        view.expanded,
        theme,
        presentation.contentOnly,
      ),
      shouldAnimate: false,
    };
  let details: CodeModeRenderDetails;
  try {
    details = decodeCodeModeRenderDetails(result.details);
  } catch {
    details = decodeCodeModeRenderDetails(undefined);
  }
  const shouldAnimate =
    view.isPartial && details.toolCalls.some((call) => call.status === "running");
  // A drawing failure falls back to plain text rather than Pi's unframed JSON.
  const emergency = (): Component => {
    const output = emergencyResultText(result);
    const label = view.isPartial ? "Code Mode running" : view.isError ? "Code Mode failed" : "";
    const body = view.isPartial || output.length === 0 ? "" : view.expanded ? output : "";
    return new Text([label, body].filter(Boolean).join("\n"), 0, 0);
  };
  try {
    const component = renderCodeModeToolResultUnsafe(
      result,
      details,
      view,
      theme,
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
