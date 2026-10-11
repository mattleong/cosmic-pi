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
import type { PreviewRenderers, RendererState } from "./shared/types";
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
import { stateHeading } from "./shared/state-heading";
import { countLabel } from "pi-cosmic-core";
import { previewIssuesSlot } from "../../preview/preview-issues";

const COLLAPSED_EDIT_BLOCKS = 3;

type ProposedDiff =
  | { readonly kind: "diff"; readonly diff: string; readonly summary: DiffSummary }
  | { readonly kind: "skipped"; readonly guard: "size" | "complexity" };

export function editPreviewRenderers(cwd: string): PreviewRenderers {
  return {
    renderCall(args, theme, renderContext) {
      const { state, expanded, invalidate } = renderContext;
      const path = getPathArg(args);
      const operations = getEditPreviewOperations(args);
      const operationsSource = editOperationsSource(operations);
      if (state.editArgsPath !== path || state.editArgsExactSource !== operationsSource) {
        state.editArgsPath = path;
        state.editArgsExactSource = operationsSource;
        state.editSummaryText = undefined;
      }

      const title = `${renderCodePreviewToolTitle("edit", theme)} ${renderDisplayPath(path, cwd, theme)}`;
      const separator = diffSummarySeparator(theme);
      const preview = new Container();
      preview.addChild(
        stateHeading(() => {
          const summary = state.editSummaryText;
          return Predicate.isString(summary) && summary ? title + separator + summary : title;
        }),
      );
      preview.addChild(previewIssuesSlot(renderContext));
      if (!renderContext.argsComplete || operations.length === 0) return preview;

      if (!expanded && !codePreviewSettings.editDiffPreview) {
        preview.addChild(renderHiddenPreviewExpandHint(state, theme, "proposed edit"));
        return preview;
      }

      const previewKey = previewCacheKey(
        [operationsSource],
        path,
        expanded,
        theme,
        codePreviewSettings.editCollapsedLines,
      );
      const render = () =>
        renderEditCallPreview(
          operations,
          proposedDiffs(state, operationsSource),
          path,
          expanded,
          theme,
          invalidate,
        );
      const proposal = () =>
        cachedDeferredPreview(
          state,
          "editCallPreview",
          previewKey,
          operations.reduce(
            (total, { oldText, newText }) => total + oldText.length + newText.length,
            0,
          ),
          "Rendering proposed edit diff…",
          theme,
          render,
          invalidate,
        );
      preview.addChild(unlessResultDiffShown(state, proposal));
      return preview;
    },

    renderResult: (result, { expanded, isPartial }, theme, renderContext) => {
      setResultDiffShown(renderContext.state, false);
      if (isPartial) return new Text(theme.fg("warning", "Editing…"), 0, 0);

      const firstText = getTextContent(result.content);
      if (renderContext.isError) {
        renderContext.state.editSummaryText = undefined;
        return renderPreviewError(theme, expanded, firstText);
      }

      const diff = getEditDiff(result.details);
      if (!diff) {
        renderContext.state.editSummaryText = theme.fg("muted", "no diff");
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
      if (hidePreview) {
        const callHint =
          renderContext.argsComplete && getEditPreviewOperations(renderContext.args).length > 0;
        return callHint
          ? new Container()
          : renderHiddenPreviewExpandHint(renderContext.state, theme, "diff");
      }
      setResultDiffShown(renderContext.state, !expanded);
      const { invalidate } = renderContext;
      const render = () =>
        new FullWidthDiffText(
          formatDiffPreview(diff, pathPreviewLanguage(filePath), theme, limit, {
            totalLines: summary.totalLines,
            invalidate,
          }),
          theme,
        );
      const previewKey = previewCacheKey(
        [diff],
        filePath,
        expanded,
        theme,
        codePreviewSettings.editCollapsedLines,
      );
      return cachedDeferredPreview(
        renderContext.state,
        "editResultPreview",
        previewKey,
        diff.length,
        "Rendering edit diff…",
        theme,
        render,
        invalidate,
      );
    },
  };
}

function editOperationsSource(operations: EditPreviewOperation[]): string {
  return JSON.stringify(operations.map(({ oldText, newText }) => [oldText, newText]));
}

function proposedDiffs(state: RendererState, source: string): Array<ProposedDiff | undefined> {
  const cached = state.editProposedDiffs;
  if (cached?.source === source && Array.isArray(cached.diffs)) return cached.diffs;
  const diffs: Array<ProposedDiff | undefined> = [];
  state.editProposedDiffs = { source, diffs };
  return diffs;
}

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
  const blockLimit =
    operations.length > 1 && collapsedLines !== "all"
      ? Math.max(8, Math.floor(collapsedLines / shown))
      : collapsedLines;
  const sections: string[] = [];
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

function formatEditSummary(summary: DiffSummary, limit: number, theme: Theme): string {
  const separator = diffSummarySeparator(theme);
  let text = `${theme.fg("muted", countLabel(summary.hunks, "hunk"))}${separator}${diffCounts(theme, summary)}`;
  if (summary.totalLines > limit)
    text += separator + theme.fg("muted", `showing ${limit}/${summary.totalLines} diff lines`);
  return text;
}
