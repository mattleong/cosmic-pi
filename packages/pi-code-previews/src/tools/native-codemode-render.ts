import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import { renderExpansionAffordance, renderToolHeader, toolRunningLine } from "pi-cosmic-ui/tool";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { codePreviewSettings } from "../config/state";
import { expandedSection } from "../preview/expanded-section";
import { renderCompactChildren } from "../preview/compact-children";
import { previewIssuesSlot } from "../preview/preview-issues";
import { timingState } from "../preview/tool-timing";
import { renderNativeCodemodeProgram } from "./native-codemode-source";
import { escapeControlChars } from "../shared/terminal-text";
import { renderHighlightedText } from "../syntax/render";
import type { CompactAnimationScheduler } from "./compact-summary";
import { withCodePreviewRenderers, type CodePreviewShellOptions } from "./cooperative-tools";
import { getFallbackResultText } from "./data/results";
import {
  nativeCodemodeChildren,
  nativeCodemodeHeader,
  nativeCodemodeSummary,
} from "./native-codemode-summary";
import { nativeCodemodeEvidence, nativeEvidenceCoverage } from "./native-codemode-evidence";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";

/** Source and output survive even if a host theme/highlighter fails during construction/draw. */
function safeContent(
  build: () => Component,
  raw: string,
  fallback: Component = new Text(escapeControlChars(raw), 0, 0),
): Component {
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

/** Presentation only; the lifecycle admits the current public builtin codemode source. */
export function createNativeCodemodeRenderers(
  cwd: string,
  scheduleAnimation: CompactAnimationScheduler,
  appearance: Pick<CodePreviewShellOptions, "selfShell" | "mode" | "collapsedStyle"> = {},
): ToolRenderers {
  const summary = nativeCodemodeSummary(cwd);
  const previewStyle =
    (appearance.collapsedStyle ?? codePreviewSettings.toolCallCollapsedStyle) === "preview";
  const renderSource: NonNullable<ToolRenderers["renderCall"]> = (args, theme, context) => {
    const source =
      Predicate.hasProperty(args, "code") && Predicate.isString(args.code) ? args.code : "";
    return safeContent(
      () =>
        expandedSection(
          theme,
          "Program",
          new Text(
            renderHighlightedText(source, "javascript", theme, context.invalidate).join("\n"),
            0,
            0,
          ),
        ),
      source,
    );
  };

  const renderOutput: NonNullable<ToolRenderers["renderResult"]> = (
    result,
    _options,
    theme,
    context,
  ) => {
    const raw = getFallbackResultText(result.content, context.showImages);
    return safeContent(() => {
      const body = new Container();
      const evidence = nativeCodemodeEvidence(result.details);
      const children = nativeCodemodeChildren(
        evidence,
        context.isPartial ? "running" : "settled",
        cwd,
      );
      if (children.entries.length || evidence.kind === "unavailable" || !evidence.complete)
        body.addChild(
          expandedSection(theme, "Calls", {
            render(width) {
              const rows = renderCompactChildren(children, theme, width, {
                all: true,
                layout: "flat",
                animationFrame: timingState(context).codePreviewAnimationFrame ?? 0,
                timingEnabled: codePreviewSettings.toolCallTiming,
              });
              if (evidence.kind === "unavailable" || !evidence.complete)
                rows.push(
                  ...new Text(theme.fg("muted", nativeEvidenceCoverage(evidence)), 0, 0).render(
                    width,
                  ),
                );
              return rows;
            },
            invalidate() {},
          }),
        );
      if (
        previewStyle &&
        context.isPartial &&
        !children.entries.some((child) => child.status === "running")
      )
        body.addChild({
          render(width) {
            return new Text(
              toolRunningLine(theme, timingState(context).codePreviewAnimationFrame ?? 0),
              0,
              0,
            ).render(width);
          },
          invalidate() {},
        });
      if (evidence.fullOutputPath && !nativeCodemodeHeader(result))
        body.addChild(
          expandedSection(
            theme,
            "Saved output",
            new Text(theme.fg("muted", sanitizeDiagnosticContent(evidence.fullOutputPath)), 0, 0),
          ),
        );
      // Every native text part, including headers, recovery notes, and spill paths, is retained.
      // Pi displays native images; the shared fallback preserves unavailable-image placeholders.
      if (raw)
        body.addChild(
          expandedSection(
            theme,
            "Output",
            new Text(
              raw
                .split("\n")
                .map((line) => theme.fg("toolOutput", escapeControlChars(line)))
                .join("\n"),
              0,
              0,
            ),
          ),
        );
      return body;
    }, raw);
  };

  return withCodePreviewRenderers(
    { name: "codemode" },
    {
      renderCall(args, theme, context) {
        const source =
          Predicate.hasProperty(args, "code") && Predicate.isString(args.code) ? args.code : "";
        const program = renderNativeCodemodeProgram(source, theme, context);
        const fallback = new Container();
        fallback.addChild(new Text("codemode", 0, 0));
        fallback.addChild(program);
        return safeContent(
          () => {
            const body = new Container();
            body.addChild(new Text(renderToolHeader({ title: "codemode" }, theme), 0, 0));
            body.addChild(previewIssuesSlot(context));
            body.addChild(program);
            return body;
          },
          `codemode\n${source}`,
          fallback,
        );
      },
      renderResult(result, options, theme, context) {
        if (options.expanded) return renderOutput(result, options, theme, context);
        const projected = summary({
          phase: options.isPartial ? "running" : "settled",
          args: context.args,
          result,
          context,
        });
        if (!projected)
          return safeContent(
            () => new Text(theme.fg("muted", "Details on expand"), 0, 0),
            "Details on expand",
          );
        return safeContent(
          () => ({
            render(width) {
              const animationFrame = timingState(context).codePreviewAnimationFrame ?? 0;
              const rows = renderCompactChildren(projected.children, theme, width, {
                animationFrame,
                timingEnabled: codePreviewSettings.toolCallTiming,
              });
              if (
                options.isPartial &&
                !projected.children?.entries.some((child) => child.status === "running")
              )
                rows.push(...new Text(toolRunningLine(theme, animationFrame), 0, 0).render(width));
              if (!options.isPartial && result.content.length)
                rows.push(
                  clipToWidth(
                    renderExpansionAffordance(
                      context.isError || projected.outcome === "error" ? "error" : "output",
                      false,
                      theme,
                    ),
                    width,
                    "",
                  ),
                );
              return rows;
            },
            invalidate() {},
          }),
          "Details on expand",
        );
      },
    },
    {
      ...appearance,
      compactSummary: summary,
      animateProgress: true,
      showShortTiming: true,
      scheduleAnimation,
      expandedContent: { renderCall: renderSource, renderResult: renderOutput },
    },
  );
}
