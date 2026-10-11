import * as Predicate from "effect/Predicate";

import { createWriteToolDefinition, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { hasCodePreviewSessionCapability } from "../../application/capability";
import { FullWidthDiffText } from "../../diff/full-width-text";
import { createSimpleDiff } from "../../diff/structured";
import { describeDiffContract, diffSummarySeparator, summarizeDiff } from "../../diff/summary";
import { renderDisplayPath } from "../../paths/display";
import { metadata } from "../../preview/format";
import { countContentLines } from "../../preview/line-counts";
import { hiddenPreviewExpandHintForShell } from "../../preview/bordered-tool-call";
import { codePreviewSettings } from "../../config/state";
import { getObjectValue } from "../../shared/helpers";
import { escapeControlChars } from "../../shared/terminal-text";
import { normalizePreviewLanguageAlias } from "../../syntax/language";
import { getPathArg } from "../data/args";
import { getTextContent } from "../data/results";
import { renderCodePreviewToolTitle } from "../presentation";
import { executeWriteWithPreview, isKnownNewWrite } from "../../write/preview-execution";
import { cachedDeferredPreview, cachedPreview } from "./shared/cache";
import { previewCacheKey } from "./shared/preview-cache-key";
import { pathPreviewLanguage, renderContentPreview } from "./shared/preview-text";
import {
  diffCounts,
  diffPreviewLineLimit,
  diffSkippedNote,
  formatDiffPreview,
} from "./shared/diff-preview";
import { setResultDiffShown, unlessResultDiffShown } from "./shared/result-diff";
import { renderPreviewError } from "./shared/result-prelude";
import { stateHeading } from "./shared/state-heading";
import type { PreviewRenderers } from "./shared/types";
import { writeBeforeSnapshot, writeDiffPlan } from "./shared/write-result";
import { countLabel, formatBytes } from "pi-cosmic-core";
import { previewIssuesSlot } from "../../preview/preview-issues";

export function createWritePreviewTool(cwd: string) {
  const originalWrite = createWriteToolDefinition(cwd);

  // Native rendering is selected independently; the hook owns execution only.
  const { renderCall: _renderCall, renderResult: _renderResult, ...definition } = originalWrite;
  return {
    ...definition,
    execute(...args: Parameters<typeof originalWrite.execute>) {
      const [toolCallId, params, signal, , ctx] = args;
      const path = getPathArg(params);
      const content = getObjectValue(params, "content");
      // Pi writes directly without a preview session or for arguments its schema would refuse.
      if (!path || !Predicate.isString(content) || !hasCodePreviewSessionCapability())
        return originalWrite.execute(...args);
      return executeWriteWithPreview(toolCallId, path, content, cwd, signal, ctx);
    },
  };
}

/** Presentation is independent of the before-write execution hook. */
export function writePreviewRenderers(cwd: string): PreviewRenderers {
  return {
    renderCall(args, theme, renderContext) {
      // Closures keep only these, never the context: its lastComponent links every prior call.
      const { state, expanded, invalidate } = renderContext;
      const path = getPathArg(args);
      const content = Predicate.isString(args.content) ? args.content : "";
      const lang = pathPreviewLanguage(path, content);
      const title = `${renderCodePreviewToolTitle("write", theme)} ${renderDisplayPath(path, cwd, theme)}`;
      const details = [
        formatBytes(Buffer.byteLength(content, "utf8")),
        countLabel(countContentLines(content), "line"),
        lang ? normalizePreviewLanguageAlias(lang) : undefined,
      ];
      const existingHeader = title + metadata(theme, details);
      const newHeader = title + metadata(theme, ["new file", ...details]);
      const container = new Container();
      // The result settles whether the file is new after the call is built, before it is drawn.
      container.addChild(
        stateHeading(() => (state.writeNewFile === true ? newHeader : existingHeader)),
      );
      // Issues sit directly under the heading, above the content they may describe.
      container.addChild(previewIssuesSlot(renderContext));
      if (!expanded && !codePreviewSettings.writeContentPreview) {
        const hint = hiddenPreviewExpandHintForShell(state, theme, "content");
        if (hint) container.addChild(new Text(hint, 0, 0));
        return container;
      }
      const collapsedLines = codePreviewSettings.writeCollapsedLines;
      const previewKey = previewCacheKey([content], path, expanded, theme, collapsedLines);
      const preview = () =>
        cachedPreview(state, "writeCallPreview", previewKey, () =>
          renderContentPreview({
            content,
            limit: expanded ? 0 : collapsedLines,
            lang,
            theme,
            invalidate,
            emptyLabel: "Empty content",
            skipHighlightLabel: "Syntax highlighting skipped for large content",
          }),
        );
      // The proposed content stays until the applied diff replaces it.
      container.addChild(unlessResultDiffShown(state, preview));
      return container;
    },

    renderResult: (result, { expanded }, theme, renderContext) => {
      const state = renderContext.state;
      setResultDiffShown(state, false);
      const firstText = getTextContent(result.content);
      if (renderContext.isError) {
        state.writeNewFile = false;
        return renderPreviewError(theme, expanded, firstText);
      }

      const path = getPathArg(renderContext.args);
      const before = writeBeforeSnapshot(state, renderContext.toolCallId, result.details);
      // Only an observed absent file is new; the heading says so once the write is known.
      state.writeNewFile = isKnownNewWrite(before, result.details);
      const plan = writeDiffPlan(before, getObjectValue(renderContext.args, "content"));
      if (plan.kind === "skipped")
        return plan.measured
          ? new Text(theme.fg("muted", `diff skipped: ${escapeControlChars(plan.reason)}`), 0, 0)
          : new Container();
      if (plan.kind === "unknown") return new Container();
      if (plan.kind === "unchanged") return new Text(theme.fg("muted", "no changes"), 0, 0);
      // A hidden collapsed preview leaves expansion to the call's hint.
      if (!expanded && !codePreviewSettings.writeContentPreview) return new Container();
      if (plan.kind === "guarded") return new Text(diffSkippedNote(theme, plan.guard), 0, 0);
      const { previous, content } = plan;
      // Expansion keeps the exact written content above the diff.
      setResultDiffShown(state, !expanded);
      const render = () =>
        renderWriteDiffPreview(previous, content, path, expanded, theme, renderContext.invalidate);
      const previewKey = previewCacheKey(
        [previous, content],
        path,
        expanded,
        theme,
        codePreviewSettings.writeCollapsedLines,
      );
      return cachedDeferredPreview(
        state,
        "writeResultPreview",
        previewKey,
        `${previous}\0${content}`,
        "Rendering write diff…",
        theme,
        render,
        renderContext.invalidate,
      );
    },
  };
}

function renderWriteDiffPreview(
  before: string,
  content: string,
  path: string,
  expanded: boolean,
  theme: Theme,
  invalidate?: () => void,
): FullWidthDiffText {
  const diff = createSimpleDiff(before, content);
  const summary = summarizeDiff(diff);
  const limit = diffPreviewLineLimit(
    summary.totalLines,
    expanded,
    codePreviewSettings.writeCollapsedLines,
  );
  const header = `${theme.fg("muted", describeDiffContract(summary))}${diffSummarySeparator(theme)}${diffCounts(theme, summary)}\n`;
  const preview = formatDiffPreview(diff, pathPreviewLanguage(path, content), theme, limit, {
    totalLines: summary.totalLines,
    invalidate,
  });
  return new FullWidthDiffText(header + preview, theme);
}
