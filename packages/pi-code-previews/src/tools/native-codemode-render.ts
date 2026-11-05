import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Result from "effect/Result";
import { renderExpansionAffordance, renderToolHeader, toolRunningLine } from "pi-cosmic-ui/tool";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { hostContainer, type HostContainer } from "../shared/untrusted-value";
import { codePreviewSettings } from "../config/state";
import { expandedSection } from "../preview/expanded-section";
import { renderCompactChildren } from "../preview/compact-children";
import { previewIssuesSlot } from "../preview/preview-issues";
import { getCodePreviewAnimationFrame } from "../preview/tool-timing";
import { renderNativeCodemodeProgram } from "./native-codemode-source";
import { escapeControlChars } from "../shared/terminal-text";
import type { CodePreviewRendererAppearance } from "../application/renderer-contract";
import type { CompactSummary } from "./compact-summary";
import { withCodePreviewRenderers } from "./cooperative-tools";
import { getFallbackResultText, getTextContent } from "./data/results";
import type {
  CodePreviewRenderers,
  RenderCall,
  RendererState,
  RenderResult,
} from "./renderers/shared/types";
import {
  nativeCodemodeChildren,
  nativeCodemodeHeader,
  nativeCodemodeSummary,
} from "./native-codemode-summary";
import {
  nativeCodemodeEvidence,
  nativeEvidenceCoverage,
  type NativeCallEvidence,
} from "./native-codemode-evidence";
import { ownString, runningLine, safeContent } from "./native-safe-content";
import { parseNativeTruncatedOutput } from "./native-truncation";
import {
  renderScriptOutput,
  splitScriptError,
  withoutCallSummary,
  withoutRestatedError,
} from "./native-codemode-output";
import { sanitizeDiagnosticContent } from "pi-cosmic-core/security";
import { argumentsStreaming } from "./renderers/shared/preview-text";
import {
  createNativeDiscoveryProjector,
  nativeDiscoveryLabel,
  nativeDiscoveryNote,
  type NativeDiscoveryProjector,
} from "./native-codemode-discovery";

const programSource = (args: HostContainer | undefined): string => ownString(args, "code") ?? "";

const renderSource =
  (discovery: NativeDiscoveryProjector): RenderCall<unknown, RendererState> =>
  (args, theme, context) => {
    const input = hostContainer(args);
    const program = renderNativeCodemodeProgram(
      programSource(input),
      theme,
      {
        expanded: true,
        argumentsStreaming: argumentsStreaming(context),
        invalidate: context.invalidate,
      },
      discovery(input) ? nativeDiscoveryNote : undefined,
    );
    return safeContent(() => expandedSection(theme, "Program", program), program);
  };

function renderCallList(
  children: NonNullable<CompactSummary["children"]>,
  evidence: NativeCallEvidence,
  theme: Theme,
  state: RendererState,
): Component {
  const animated = Arr.some(
    children.entries,
    (child) => child.status === "pending" || child.status === "running",
  );
  const coverage =
    evidence.kind === "unavailable" || !evidence.complete
      ? nativeEvidenceCoverage(evidence)
      : undefined;
  let cached: { readonly key: string; readonly rows: string[] } | undefined;
  return {
    render(width) {
      const animationFrame = animated ? getCodePreviewAnimationFrame({ state }) : 0;
      const timingEnabled = codePreviewSettings.toolCallTiming;
      const key = `${width}:${animationFrame}:${timingEnabled}`;
      if (cached?.key === key) return cached.rows;
      const rows = renderCompactChildren(children, theme, width, {
        all: true,
        layout: "flat",
        animationFrame,
        timingEnabled,
      });
      if (coverage) rows.push(...new Text(theme.fg("muted", coverage), 0, 0).render(width));
      cached = { key, rows };
      return rows;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

const rawText = (text: string) => (theme: Theme) =>
  Arr.join(
    Arr.map(Str.split(text, "\n"), (line) => theme.fg("toolOutput", escapeControlChars(line))),
    "\n",
  );

export function createNativeCodemodeRenderers(
  cwd: string,
  appearance: CodePreviewRendererAppearance,
): CodePreviewRenderers<unknown, unknown, RendererState> {
  const discovery = createNativeDiscoveryProjector();
  const summary = nativeCodemodeSummary(cwd, discovery);
  const previewStyle =
    (appearance.collapsedStyle ?? codePreviewSettings.toolCallCollapsedStyle) === "preview";

  // The shared expanded composition states that the script is still running under its heading,
  // so only the tool's own expanded body, drawn without that composition, says so here.
  const outputRenderer =
    (statesRunning: boolean): RenderResult<unknown, unknown, RendererState> =>
    (result, _options, theme, context) => {
      const raw = getFallbackResultText(result.content, context.showImages);
      return safeContent(() => {
        const body = new Container();
        const evidence = nativeCodemodeEvidence(hostContainer(result.details));
        const children = nativeCodemodeChildren(
          evidence,
          context.isPartial ? "running" : "settled",
          cwd,
        );
        if (children.entries.length || evidence.kind === "unavailable" || !evidence.complete)
          body.addChild(
            expandedSection(
              theme,
              "Calls",
              renderCallList(children, evidence, theme, context.state),
            ),
          );
        if (
          statesRunning &&
          previewStyle &&
          context.isPartial &&
          !Arr.some(children.entries, (child) => child.status === "running")
        )
          body.addChild(runningLine(theme, context.state));
        if (evidence.fullOutputPath && !nativeCodemodeHeader(result))
          body.addChild(
            expandedSection(
              theme,
              "Saved output",
              new Text(theme.fg("muted", sanitizeDiagnosticContent(evidence.fullOutputPath)), 0, 0),
            ),
          );
        for (const [label, text] of outputSections(result, evidence, context))
          body.addChild(expandedSection(theme, label, new Text(text(theme), 0, 0)));
        return body;
      }, raw);
    };
  const renderOutput = outputRenderer(true);

  // Pi's header restates the outcome and timing the heading shows, and a script error that an
  // issue already details would otherwise appear twice.
  function outputSections(
    result: Parameters<typeof renderOutput>[0],
    evidence: ReturnType<typeof nativeCodemodeEvidence>,
    context: Parameters<typeof renderOutput>[3],
  ): Array<readonly [string, (theme: Theme) => string]> {
    const header = nativeCodemodeHeader(result);
    if (!header) {
      const raw = getFallbackResultText(result.content, context.showImages);
      return raw ? [["Output", rawText(raw)]] : [];
    }
    const parts = result.content.slice(1);
    const text = getTextContent(parts);
    const images = getFallbackResultText(
      Arr.filter(parts, (part) => part.type === "image"),
      context.showImages,
    );
    const second = result.content[1];
    const truncated =
      evidence.fullOutputPath !== undefined ||
      (second?.type === "text" && parseNativeTruncatedOutput(second.text) !== undefined);
    const withImages = (body: string) => Arr.join(Arr.filter([body, images], Str.isNonEmpty), "\n");
    if (truncated) {
      const raw = withImages(text);
      return Str.trim(raw) ? [["Output", rawText(raw)]] : [];
    }
    const { output, scriptError } = splitScriptError(text);
    const sections: Array<readonly [string, (theme: Theme) => string]> = [];
    if (Str.trim(output) || images)
      sections.push([
        "Output",
        (theme) =>
          Arr.join(
            [
              ...(Str.trim(output) ? [renderScriptOutput(Str.trimEnd(output), theme)] : []),
              ...(images ? [rawText(images)(theme)] : []),
            ],
            "\n",
          ),
      ]);
    if (scriptError !== undefined && !scriptErrorIssued(result, context)) {
      const childErrors = evidence.kind === "available" ? evidence.calls : [];
      const unexplained = withoutRestatedError(
        scriptError,
        Arr.filterMap(childErrors, (call) =>
          call.status === "error" && call.error !== undefined
            ? Result.succeed(call.error)
            : Result.failVoid,
        ),
      );
      const complete = evidence.kind === "available" && evidence.complete;
      const remaining = Str.trim(complete ? withoutCallSummary(unexplained) : unexplained);
      if (remaining) sections.push(["Script error", rawText(remaining)]);
    }
    return sections;
  }

  function scriptErrorIssued(
    result: Parameters<typeof renderOutput>[0],
    context: Parameters<typeof renderOutput>[3],
  ): boolean {
    const args = Predicate.isObject(context.args) ? context.args : {};
    const projected = summary({
      phase: "settled",
      args,
      result,
      context: { ...context, args },
    });
    return Arr.some(projected?.issues ?? [], (issue) => issue.code === "native-script-error");
  }

  return withCodePreviewRenderers<unknown, unknown, RendererState>(
    { name: "codemode" },
    {
      renderCall(args, theme, context) {
        const input = hostContainer(args);
        const label = nativeDiscoveryLabel(discovery(input));
        const program = renderNativeCodemodeProgram(
          programSource(input),
          theme,
          {
            expanded: context.expanded,
            argumentsStreaming: argumentsStreaming(context),
            invalidate: context.invalidate,
          },
          label ? nativeDiscoveryNote : undefined,
        );
        const fallback = new Container();
        fallback.addChild(new Text(label ? `codemode ${label}` : "codemode", 0, 0));
        fallback.addChild(program);
        return safeContent(() => {
          const body = new Container();
          body.addChild(
            new Text(
              renderToolHeader({ title: "codemode", ...(label && { subtitle: label }) }, theme),
              0,
              0,
            ),
          );
          body.addChild(previewIssuesSlot(context));
          body.addChild(program);
          return body;
        }, fallback);
      },
      renderResult(result, options, theme, context) {
        if (options.expanded) return renderOutput(result, options, theme, context);
        const { state, isError } = context;
        const args = Predicate.isObject(context.args) ? context.args : {};
        const projected = summary({
          phase: options.isPartial ? "running" : "settled",
          args,
          result,
          context: { ...context, args },
        });
        if (!projected)
          return safeContent(
            () => new Text(renderExpansionAffordance("details", false, theme), 0, 0),
            "▸ details",
          );
        let cached: { readonly key: string; readonly rows: string[] } | undefined;
        return safeContent(
          () => ({
            render(width) {
              const animationFrame = getCodePreviewAnimationFrame({ state });
              const timingEnabled = codePreviewSettings.toolCallTiming;
              const key = `${width}:${animationFrame}:${timingEnabled}`;
              if (cached?.key === key) return cached.rows;
              const rows = renderCompactChildren(projected.children, theme, width, {
                animationFrame,
                timingEnabled,
              });
              const counter = projected.action ? projected.counters?.[0] : undefined;
              if (counter) rows.unshift(clipToWidth(theme.fg("muted", counter), width));
              if (
                options.isPartial &&
                !Arr.some(projected.children?.entries ?? [], (child) => child.status === "running")
              )
                rows.push(...new Text(toolRunningLine(theme, animationFrame), 0, 0).render(width));
              if (!options.isPartial && result.content.length)
                rows.push(
                  clipToWidth(
                    renderExpansionAffordance(
                      isError || projected.outcome === "error" ? "error" : "output",
                      false,
                      theme,
                    ),
                    width,
                    "",
                  ),
                );
              cached = { key, rows };
              return rows;
            },
            invalidate() {
              cached = undefined;
            },
          }),
          "▸ details",
        );
      },
    },
    {
      ...appearance,
      compactSummary: summary,
      animateProgress: true,
      showShortTiming: true,
      expandedContent: {
        renderCall: renderSource(discovery),
        renderResult: outputRenderer(false),
      },
    },
  );
}
