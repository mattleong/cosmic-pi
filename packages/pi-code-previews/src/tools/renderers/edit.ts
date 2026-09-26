import { builtinExpandedContent } from "./shared/builtin-expanded-content";
import * as Predicate from "effect/Predicate";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { createEditToolDefinition, getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { FullWidthDiffText } from "../../diff/full-width-text";
import { createSimpleDiff } from "../../diff/structured";
import { diffSummarySeparator, summarizeDiff, type DiffSummary } from "../../diff/summary";
import { renderDisplayPath } from "../../paths/display";
import { showingFooter } from "../../preview/format";
import { renderHiddenPreviewExpandHint } from "../../preview/bordered-tool-call";
import { codePreviewSettings } from "../../config/state";
import { countLabel } from "../../shared/helpers";
import { resolvePreviewLanguage } from "../../syntax/language";
import { getEditPreviewOperations, getPathArg } from "../data/args";
import { getEditDiff, getTextContent } from "../data/results";
import { renderCodePreviewToolTitle } from "../presentation";
import { createCodePreviewToolDefinition } from "../renderer-adapter";
import { createBuiltinCompactSummary } from "../builtin-compact-summary";
import { cachedDeferredPreview } from "./shared/cache";
import type { RendererArguments, RendererState } from "./shared/types";
import { diffPreviewCacheKey } from "./shared/preview-cache-key";
import { diffPreviewLineLimit, formatDiffPreview } from "./shared/diff-preview";
import { argumentIssues, previewCallIssues, withPreviewIssues } from "./shared/preview-issues";
import { renderPreviewError } from "./shared/result-prelude";

export function createEditPreviewTool(cwd: string) {
  const originalEdit = createEditToolDefinition(cwd);

  return createCodePreviewToolDefinition(originalEdit, {
    compactSummary: (input) => createBuiltinCompactSummary("edit", input),
    expandedContent: builtinExpandedContent<typeof originalEdit>("edit", cwd),
    renderCall(args, theme, renderContext) {
      const path = getPathArg(args);
      const operations = getEditPreviewOperations(args);
      const operationsSource = editOperationsSource(operations);
      if (
        renderContext.state.editArgsPath !== path ||
        renderContext.state.editArgsExactSource !== operationsSource
      ) {
        renderContext.state.editArgsPath = path;
        renderContext.state.editArgsExactSource = operationsSource;
        renderContext.state.editSummaryText = undefined;
        renderContext.state.editCallPreviewKey = undefined;
        renderContext.state.editCallPreviewComponent = undefined;
      }

      const text =
        renderContext.lastComponent instanceof Text
          ? renderContext.lastComponent
          : new Text("", 0, 0);
      renderContext.state.editHeaderText = text;
      text.setText(formatEditHeader(path, cwd, theme, renderContext.state.editSummaryText));

      const issues = previewCallIssues(renderContext.state, theme, () =>
        argumentIssues("edit", renderContext),
      );
      if (
        !renderContext.argsComplete ||
        operations.length === 0 ||
        renderContext.executionStarted
      ) {
        const heading = new Container();
        heading.addChild(text);
        heading.addChild(issues);
        return heading;
      }

      if (!renderContext.expanded && !codePreviewSettings.editDiffPreview) {
        const preview = new Container();
        preview.addChild(text);
        preview.addChild(issues);
        preview.addChild(renderHiddenPreviewExpandHint(renderContext.state, theme));
        return preview;
      }

      const previewKey = diffPreviewCacheKey(
        "edit-call",
        operationsSource,
        path,
        renderContext.expanded,
        theme,
        codePreviewSettings.editCollapsedLines,
      );
      const render = () =>
        renderEditCallPreview(
          operations,
          path,
          renderContext.expanded,
          theme,
          renderContext.invalidate,
        );
      const preview = new Container();
      preview.addChild(text);
      preview.addChild(issues);
      preview.addChild(
        cachedDeferredPreview(
          renderContext.state,
          "editCallPreviewKey",
          "editCallPreviewComponent",
          previewKey,
          operationsSource,
          "Rendering proposed edit diff…",
          theme,
          render,
          renderContext.invalidate,
        ),
      );
      return preview;
    },

    renderResult: withPreviewIssues(
      "edit",
      (result, { expanded, isPartial }, theme, renderContext) => {
        if (isPartial) return new Text(theme.fg("warning", "Editing…"), 0, 0);

        const firstText = getTextContent(result.content);
        if (renderContext.isError) {
          renderContext.state.editSummaryText = undefined;
          updateEditHeader(renderContext, cwd, theme);
          return renderPreviewError(theme, expanded, firstText);
        }

        const diff = getEditDiff(result.details);
        if (!diff) {
          renderContext.state.editSummaryText = `${theme.fg("success", "✓ Edit applied")}${theme.fg("muted", " · no diff")}`;
          updateEditHeader(renderContext, cwd, theme);
          return new Container();
        }

        const filePath = getPathArg(renderContext.args);
        const lang = resolvePreviewLanguage({
          path: filePath,
          piLanguage: getLanguageFromPath(filePath),
        });
        const summary = summarizeDiff(diff);
        const hidePreview = !expanded && !codePreviewSettings.editDiffPreview;
        const limit = hidePreview
          ? summary.totalLines
          : diffPreviewLineLimit(
              summary.totalLines,
              expanded,
              codePreviewSettings.editCollapsedLines,
            );
        renderContext.state.editSummaryText = formatEditSummary(summary, limit, theme);
        updateEditHeader(renderContext, cwd, theme);
        if (hidePreview) return renderHiddenPreviewExpandHint(renderContext.state, theme);
        const render = () =>
          new FullWidthDiffText(
            formatDiffPreview(diff, lang, theme, limit, {
              totalLines: summary.totalLines,
              hiddenLineNoun: "diff lines",
              skipHighlightLabel: "Syntax highlighting skipped for large diff",
              invalidate: renderContext.invalidate,
            }),
            theme,
          );
        const previewKey = diffPreviewCacheKey(
          "edit-result",
          diff,
          filePath,
          expanded,
          theme,
          codePreviewSettings.editCollapsedLines,
        );
        return cachedDeferredPreview(
          renderContext.state,
          "editResultPreviewKey",
          "editResultPreviewComponent",
          previewKey,
          diff,
          "Rendering edit diff…",
          theme,
          render,
          renderContext.invalidate,
        );
      },
      "call",
    ),
  });
}

function editOperationsSource(operations: Array<{ oldText: string; newText: string }>): string {
  return operations.map((operation) => `${operation.oldText}\0${operation.newText}`).join("\0\0");
}

function renderEditCallPreview(
  operations: Array<{ oldText: string; newText: string }>,
  path: string,
  expanded: boolean,
  theme: Theme,
  invalidate?: () => void,
): FullWidthDiffText {
  const lang = resolvePreviewLanguage({ path, piLanguage: getLanguageFromPath(path) });
  const maxOperations = Math.min(operations.length, 3);
  const perOperationLimit =
    operations.length > 1
      ? Math.max(
          8,
          Math.floor(
            (Predicate.isNumber(codePreviewSettings.editCollapsedLines)
              ? codePreviewSettings.editCollapsedLines
              : 160) / maxOperations,
          ),
        )
      : undefined;
  const sections: string[] = [];
  const diffs = operations.map((operation) =>
    createSimpleDiff(operation.oldText, operation.newText),
  );
  const summaries = diffs.map((diff) => summarizeDiff(diff));
  const totalAdditions = summaries.reduce((total, summary) => total + summary.additions, 0);
  const totalRemovals = summaries.reduce((total, summary) => total + summary.removals, 0);

  for (let index = 0; index < maxOperations; index++) {
    const diff = diffs[index];
    const summary = summaries[index];
    if (diff === undefined || summary === undefined) continue;
    const limit =
      expanded || codePreviewSettings.editCollapsedLines === "all"
        ? summary.totalLines
        : (perOperationLimit ?? codePreviewSettings.editCollapsedLines);
    const rendered = formatDiffPreview(diff, lang, theme, limit, {
      totalLines: summary.totalLines,
      hiddenLineNoun: "proposed diff lines",
      skipHighlightLabel: "Syntax highlighting skipped for large proposed diff",
      invalidate,
    });
    if (operations.length > 1)
      sections.push(theme.fg("muted", `Proposed edit ${index + 1}/${operations.length}`));
    sections.push(rendered);
  }

  const remainder = operations.length - maxOperations;
  const header = `${theme.fg("muted", "proposed edit")} ${theme.fg("success", `+${totalAdditions}`)} ${theme.fg("error", `-${totalRemovals}`)}${operations.length > 1 ? theme.fg("muted", ` · ${operations.length} edit blocks`) : ""}`;
  let text = `${header}\n${sections.join("\n")}`;
  if (remainder > 0) text += showingFooter(theme, maxOperations, operations.length, "edit blocks");
  return new FullWidthDiffText(text, theme);
}

function formatEditHeader<SummaryTextInput>(
  path: string,
  cwd: string,
  theme: Theme,
  summaryText: SummaryTextInput,
): string {
  const base = `${renderCodePreviewToolTitle("edit", theme)} ${renderDisplayPath(path, cwd, theme)}`;
  return Predicate.isString(summaryText) && summaryText
    ? `${base}${diffSummarySeparator(theme)}${summaryText}`
    : base;
}

function updateEditHeader(
  context: { args: RendererArguments; state: RendererState },
  cwd: string,
  theme: Theme,
): void {
  const text = context.state.editHeaderText;
  if (text instanceof Text)
    text.setText(
      formatEditHeader(getPathArg(context.args), cwd, theme, context.state.editSummaryText),
    );
}

function formatEditSummary(summary: DiffSummary, limit: number, theme: Theme): string {
  let text = theme.fg("muted", countLabel(summary.hunks, "hunk"));
  text +=
    diffSummarySeparator(theme) +
    `${theme.fg("success", `+${summary.additions}`)} ${theme.fg("error", `-${summary.removals}`)}`;
  if (summary.totalLines > limit)
    text +=
      diffSummarySeparator(theme) +
      theme.fg("muted", `showing ${limit}/${summary.totalLines} diff lines`);
  return text;
}
