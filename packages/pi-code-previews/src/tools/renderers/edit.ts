import { builtinExpandedContent } from "./shared/builtin-expanded-content";
import * as Predicate from "effect/Predicate";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CodePreviewRendererAppearance } from "../../application/renderer-contract";
import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { FullWidthDiffText } from "../../diff/full-width-text";
import { createSnippetDiff } from "../../diff/structured";
import { diffSummarySeparator, summarizeDiff, type DiffSummary } from "../../diff/summary";
import { renderDisplayPath } from "../../paths/display";
import { showingFooter } from "../../preview/format";
import { renderHiddenPreviewExpandHint } from "../../preview/bordered-tool-call";
import { codePreviewSettings } from "../../config/state";
import { resolvePreviewLanguage } from "../../syntax/language";
import { getWriteDiffGuard } from "../../write/diff";
import { getEditPreviewOperations, getPathArg, type EditPreviewOperation } from "../data/args";
import { getEditDiff, getTextContent } from "../data/results";
import { renderCodePreviewToolTitle } from "../presentation";
import { createCodePreviewRenderers } from "../renderer-adapter";
import { createBuiltinCompactSummary } from "../builtin-compact-summary";
import { cachedDeferredPreview } from "./shared/cache";
import type { RendererArguments, RendererState } from "./shared/types";
import { diffPreviewCacheKey } from "./shared/preview-cache-key";
import { diffPreviewLineLimit, diffSkippedNote, formatDiffPreview } from "./shared/diff-preview";
import { setResultDiffShown, unlessResultDiffShown } from "./shared/result-diff";
import { renderPreviewError } from "./shared/result-prelude";
import { countLabel } from "pi-cosmic-core";
import { previewIssuesSlot } from "../../preview/preview-issues";

/** Collapsed proposals show this many edit blocks; expansion shows every block. */
const COLLAPSED_EDIT_BLOCKS = 3;

type ProposedDiff =
  | { readonly kind: "diff"; readonly diff: string; readonly summary: DiffSummary }
  | { readonly kind: "skipped"; readonly guard: "size" | "complexity" };

export function createEditPreviewTool(cwd: string, session?: CodePreviewRendererAppearance) {
  return createCodePreviewRenderers(
    { name: "edit" },
    {
      ...session,
      compactSummary: (input) => createBuiltinCompactSummary("edit", input),
      expandedContent: builtinExpandedContent("edit", cwd),
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

        const text = new Text("", 0, 0);
        renderContext.state.editHeaderText = text;
        text.setText(formatEditHeader(path, cwd, theme, renderContext.state.editSummaryText));

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
    },
  );
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
function proposedDiff(
  diffs: Array<ProposedDiff | undefined>,
  index: number,
  operation: EditPreviewOperation,
): ProposedDiff {
  const cached = diffs[index];
  if (cached) return cached;
  const guard = getWriteDiffGuard(operation.oldText, operation.newText);
  let proposed: ProposedDiff;
  if (guard) proposed = { kind: "skipped", guard };
  else {
    const diff = createSnippetDiff(operation.oldText, operation.newText);
    proposed = { kind: "diff", diff, summary: summarizeDiff(diff) };
  }
  diffs[index] = proposed;
  return proposed;
}

function renderEditCallPreview(
  operations: EditPreviewOperation[],
  diffs: Array<ProposedDiff | undefined>,
  path: string,
  expanded: boolean,
  theme: Theme,
  invalidate?: () => void,
): FullWidthDiffText {
  const lang = resolvePreviewLanguage({ path, piLanguage: getLanguageFromPath(path) });
  const shown = expanded ? operations.length : Math.min(operations.length, COLLAPSED_EDIT_BLOCKS);
  const perOperationLimit =
    operations.length > 1
      ? Math.max(
          8,
          Math.floor(
            (Predicate.isNumber(codePreviewSettings.editCollapsedLines)
              ? codePreviewSettings.editCollapsedLines
              : 160) / shown,
          ),
        )
      : undefined;
  const sections: string[] = [];
  // Totals cover the whole edit only when every block was diffed.
  let complete = shown === operations.length;
  let additions = 0;
  let removals = 0;

  for (let index = 0; index < shown; index++) {
    const operation = operations[index];
    if (operation === undefined) continue;
    if (operations.length > 1)
      sections.push(theme.fg("muted", `Proposed edit ${index + 1}/${operations.length}`));
    const proposed = proposedDiff(diffs, index, operation);
    if (proposed.kind === "skipped") {
      complete = false;
      sections.push(diffSkippedNote(theme, proposed.guard));
      continue;
    }
    const { diff, summary } = proposed;
    additions += summary.additions;
    removals += summary.removals;
    const limit =
      expanded || codePreviewSettings.editCollapsedLines === "all"
        ? summary.totalLines
        : (perOperationLimit ?? codePreviewSettings.editCollapsedLines);
    // Snippet rows have no file positions, so they carry only their +/- markers.
    sections.push(
      formatDiffPreview(diff, lang, theme, limit, {
        totalLines: summary.totalLines,
        hiddenLineNoun: "proposed diff lines",
        skipHighlightLabel: "Syntax highlighting skipped for large proposed diff",
        invalidate,
        lineNumbers: false,
      }),
    );
  }

  const counts = complete
    ? ` ${theme.fg("success", `+${additions}`)} ${theme.fg("error", `-${removals}`)}`
    : "";
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
