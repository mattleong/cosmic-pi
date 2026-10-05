import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import { renderExpansionAffordance, renderToolHeader, toolRunningLine } from "pi-cosmic-ui/tool";
import { clipToWidth } from "pi-cosmic-ui/manager";
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
import { getFallbackResultText } from "./data/results";
import type { ToolRenderContext } from "./renderers/shared/types";
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
import { safeContent } from "./native-safe-content";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import {
  createNativeDiscoveryProjector,
  nativeDiscoveryLabel,
  nativeDiscoveryNote,
  type NativeDiscoveryProjector,
} from "./native-codemode-discovery";

/** The complete program, highlighted, for the expanded view. */
const renderSource =
  (discovery: NativeDiscoveryProjector): NonNullable<ToolRenderers["renderCall"]> =>
  (args, theme, context) => {
    const source =
      Predicate.hasProperty(args, "code") && Predicate.isString(args.code) ? args.code : "";
    const program = renderNativeCodemodeProgram(
      source,
      theme,
      { expanded: true, invalidate: context.invalidate },
      discovery(args) ? nativeDiscoveryNote : undefined,
    );
    return safeContent(() => expandedSection(theme, "Program", program), program);
  };

/**
 * Expanded Calls rows, laid out once per width rather than on every frame for up to 256 calls.
 * A new result builds a new list, and invalidation (such as a theme change) clears the rows.
 * Only pending and running rows animate, so only they make the rows depend on the frame.
 */
function renderCallList(
  children: NonNullable<CompactSummary["children"]>,
  evidence: NativeCallEvidence,
  theme: Theme,
  context: ToolRenderContext<any, any>,
): Component {
  const animated = children.entries.some(
    (child) => child.status === "pending" || child.status === "running",
  );
  const coverage =
    evidence.kind === "unavailable" || !evidence.complete
      ? nativeEvidenceCoverage(evidence)
      : undefined;
  let cached: { readonly key: string; readonly rows: string[] } | undefined;
  return {
    render(width) {
      const animationFrame = animated ? getCodePreviewAnimationFrame(context) : 0;
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

/**
 * Presentation only; the lifecycle admits the current public builtin codemode source. The owning
 * session supplies the scheduler.
 */
export function createNativeCodemodeRenderers(
  cwd: string,
  appearance: Pick<CodePreviewRendererAppearance, "scheduleAnimation"> &
    Partial<CodePreviewRendererAppearance>,
): ToolRenderers {
  const discovery = createNativeDiscoveryProjector();
  const summary = nativeCodemodeSummary(cwd, discovery);
  const previewStyle =
    (appearance.collapsedStyle ?? codePreviewSettings.toolCallCollapsedStyle) === "preview";

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
          expandedSection(theme, "Calls", renderCallList(children, evidence, theme, context)),
        );
      if (
        previewStyle &&
        context.isPartial &&
        !children.entries.some((child) => child.status === "running")
      )
        body.addChild({
          render(width) {
            return new Text(
              toolRunningLine(theme, getCodePreviewAnimationFrame(context)),
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
        const label = nativeDiscoveryLabel(discovery(args));
        const program = renderNativeCodemodeProgram(
          source,
          theme,
          context,
          label ? nativeDiscoveryNote : undefined,
        );
        const fallback = new Container();
        fallback.addChild(new Text(["codemode", label].filter(Boolean).join(" "), 0, 0));
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
              const animationFrame = getCodePreviewAnimationFrame(context);
              const rows = renderCompactChildren(projected.children, theme, width, {
                animationFrame,
                timingEnabled: codePreviewSettings.toolCallTiming,
              });
              // A discovery hint and dispatch count are independent facts in preview style too.
              const counter = projected.action ? projected.counters?.[0] : undefined;
              if (counter) rows.unshift(clipToWidth(theme.fg("muted", counter), width));
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
      expandedContent: { renderCall: renderSource(discovery), renderResult: renderOutput },
    },
  );
}
