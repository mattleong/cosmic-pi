import * as Predicate from "effect/Predicate";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { FullWidthDiffText } from "../../diff/full-width-text";
import { createSnippetDiff } from "../../diff/structured";
import { diffSummarySeparator, summarizeDiff, type DiffSummary } from "../../diff/summary";
import { renderDisplayPath } from "../../paths/display";
import { showingFooter } from "../../preview/format";
import { renderHiddenPreviewExpandHint } from "../../preview/bordered-tool-call";
import { codePreviewSettings } from "../../config/state";
import { getWriteDiffGuard } from "../../write/diff";
import { getEditPreviewOperations, getPathArg, type EditPreviewOperation } from "../data/args";
import { getEditDiff, getTextContent } from "../data/results";
import { renderCodePreviewToolTitle } from "../presentation";
import { cachedDeferredPreview } from "./shared/cache";
import type { PreviewRenderers, RendererArguments, RendererState } from "./shared/types";
import { previewCacheKey } from "./shared/preview-cache-key";
import { pathPreviewLanguage } from "./shared/preview-text";
import {
  diffCounts,
  diffPreviewLineLimit,
  diffSkippedNote,
  formatDiffPreview,
} from "./shared/diff-preview";
import { setResultDiffShown, unlessResultDiffShown } from "./shared/result-diff";
import { renderPreviewError } from "./shared/result-prelude";
import { countLabel } from "pi-cosmic-core";
import { previewIssuesSlot } from "../../preview/preview-issues";

/** Collapsed proposals show this many edit blocks; expansion shows every block. */
const COLLAPSED_EDIT_BLOCKS = 3;

type ProposedDiff =
  | { readonly kind: "diff"; readonly diff: string; readonly summary: DiffSummary }
  | { readonly kind: "skipped"; readonly guard: "size" | "complexity" };

export function editPreviewRenderers(cwd: string): PreviewRenderers {
  return {
    renderCall(args, theme, renderContext) {
      const path = getPathArg(args);
      const operations = getEditPreviewOperations(args);
      const operationsSource = editOperationsSource(operations);
      // New arguments drop the old summary; the proposal's cache key already covers them.
      if (
        renderContext.state.editArgsPath !== path ||
        renderContext.state.editArgsExactSource !== operationsSource
      ) {
        renderContext.state.editArgsPath = path;
        renderContext.state.editArgsExactSource = operationsSource;
        renderContext.state.editSummaryText = undefined;
      }

      const text = new Text(
        formatEditHeader(path, cwd, theme, renderContext.state.editSummaryText),
        0,
        0,
      );
      renderContext.state.editHeaderText = text;

      const preview = new Container();
      preview.addChild(text);
      preview.addChild(previewIssuesSlot(renderContext));
      if (!renderContext.argsComplete || operations.length === 0) return preview;

      if (!renderContext.expanded && !codePreviewSettings.editDiffPreview) {
        preview.addChild(
          renderHiddenPreviewExpandHint(renderContext.state, theme, "proposed edit"),
        );
        return preview;
      }

      const previewKey = previewCacheKey(
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
          proposedDiffs(renderContext.state, operationsSource),
          path,
          renderContext.expanded,
          theme,
          renderContext.invalidate,
        );
      const proposal = () =>
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
        );
      // The proposal stays until the applied diff replaces it.
      preview.addChild(unlessResultDiffShown(renderContext.state, proposal));
      return preview;
    },

    renderResult: (result, { expanded, isPartial }, theme, renderContext) => {
      setResultDiffShown(renderContext.state, false);
      if (isPartial) return new Text(theme.fg("warning", "Editing…"), 0, 0);

      const firstText = getTextContent(result.content);
      if (renderContext.isError) {
        renderContext.state.editSummaryText = undefined;
        updateEditHeader(renderContext, cwd, theme);
        return renderPreviewError(theme, expanded, firstText);
      }

      const diff = getEditDiff(result.details);
      if (!diff) {
        renderContext.state.editSummaryText = theme.fg("muted", "no diff");
        updateEditHeader(renderContext, cwd, theme);
        return new Container();
      }

      const filePath = getPathArg(renderContext.args);
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
      if (hidePreview) {
        // A call with a hidden proposal already offers expansion.
        const callHint =
          renderContext.argsComplete && getEditPreviewOperations(renderContext.args).length > 0;
        return callHint
          ? new Container()
          : renderHiddenPreviewExpandHint(renderContext.state, theme, "diff");
      }
      // Expansion keeps the exact proposed edits above the applied diff.
      setResultDiffShown(renderContext.state, !expanded);
      const render = () =>
        new FullWidthDiffText(
          formatDiffPreview(diff, pathPreviewLanguage(filePath), theme, limit, {
            totalLines: summary.totalLines,
            invalidate: renderContext.invalidate,
          }),
          theme,
        );
      const previewKey = previewCacheKey(
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
  };
}

function editOperationsSource(operations: EditPreviewOperation[]): string {
  return operations.map((operation) => `${operation.oldText}\0${operation.newText}`).join("\0\0");
}

/** Proposed diffs per operation, kept across expansion toggles for the same arguments. */
function proposedDiffs(state: RendererState, source: string): Array<ProposedDiff | undefined> {
  const cached = state.editProposedDiffs;
  if (cached?.source === source && Array.isArray(cached.diffs)) return cached.diffs;
  const diffs: Array<ProposedDiff | undefined> = [];
  state.editProposedDiffs = { source, diffs };
  return diffs;
}

/** Computed only when displayed; the write diff guard bounds each block's work. */
function proposeDiff({ oldText, newText }: EditPreviewOperation): ProposedDiff {
  const guard = getWriteDiffGuard(oldText, newText);
  if (guard) return { kind: "skipped", guard };
  const diff = createSnippetDiff(oldText, newText);
  return { kind: "diff", diff, summary: summarizeDiff(diff) };
}

function renderEditCallPreview(
  operations: EditPreviewOperation[],
  diffs: Array<ProposedDiff | undefined>,
  path: string,
  expanded: boolean,
  theme: Theme,
  invalidate?: () => void,
): FullWidthDiffText {
  const lang = pathPreviewLanguage(path);
  const shown = expanded ? operations.length : Math.min(operations.length, COLLAPSED_EDIT_BLOCKS);
  const collapsedLines = codePreviewSettings.editCollapsedLines;
  // Shown blocks share the collapsed line budget, each keeping at least eight lines.
  const blockLimit =
    operations.length > 1 && collapsedLines !== "all"
      ? Math.max(8, Math.floor(collapsedLines / shown))
      : collapsedLines;
  const sections: string[] = [];
  // Totals cover the whole edit only when every block was diffed.
  let complete = shown === operations.length;
  let additions = 0;
  let removals = 0;

  for (const [index, operation] of operations.slice(0, shown).entries()) {
    if (operations.length > 1)
      sections.push(theme.fg("muted", `Proposed edit ${index + 1}/${operations.length}`));
    const proposed = (diffs[index] ??= proposeDiff(operation));
    if (proposed.kind === "skipped") {
      complete = false;
      sections.push(diffSkippedNote(theme, proposed.guard));
      continue;
    }
    const { diff, summary } = proposed;
    additions += summary.additions;
    removals += summary.removals;
    const limit = diffPreviewLineLimit(summary.totalLines, expanded, blockLimit);
    sections.push(
      formatDiffPreview(diff, lang, theme, limit, {
        totalLines: summary.totalLines,
        invalidate,
        proposed: true,
      }),
    );
  }

  const counts = complete ? ` ${diffCounts(theme, { additions, removals })}` : "";
  const blocks =
    operations.length > 1 ? theme.fg("muted", ` · ${operations.length} edit blocks`) : "";
  let text = `${theme.fg("muted", "proposed edit")}${counts}${blocks}\n${sections.join("\n")}`;
  if (shown < operations.length)
    text += showingFooter(theme, shown, operations.length, "edit blocks");
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
  const separator = diffSummarySeparator(theme);
  let text = `${theme.fg("muted", countLabel(summary.hunks, "hunk"))}${separator}${diffCounts(theme, summary)}`;
  if (summary.totalLines > limit)
    text += separator + theme.fg("muted", `showing ${limit}/${summary.totalLines} diff lines`);
  return text;
}
