import * as Predicate from "effect/Predicate";

import { createWriteToolDefinition, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import {
  captureCodePreviewSessionCapability,
  hasCodePreviewSessionCapability,
} from "../../application/capability";
import { FullWidthDiffText } from "../../diff/full-width-text";
import { createSimpleDiff } from "../../diff/structured";
import { describeDiffContract, diffSummarySeparator, summarizeDiff } from "../../diff/summary";
import { renderDisplayPath } from "../../paths/display";
import { metadata } from "../../preview/format";
import { countContentLines } from "../../preview/line-counts";
import { hiddenPreviewExpandHintForShell } from "../../preview/bordered-tool-call";
import { codePreviewSettings } from "../../config/state";
import type { CodePreviewSettings } from "../../config/schema";
import { hostContainer, hostObject, ownField } from "../../shared/untrusted-value";
import { escapeControlChars } from "../../shared/terminal-text";
import { normalizePreviewLanguageAlias } from "../../syntax/language";
import { getPathArg } from "../data/args";
import { getTextContent } from "../data/results";
import { renderCodePreviewToolTitle } from "../presentation";
import { executeWriteWithPreview, isKnownNewWrite } from "../../write/preview-execution";
import { cachedDeferredPreview, cachedPreview } from "./shared/cache";
import { previewCacheKey } from "./shared/preview-cache-key";
import {
  argumentsStreaming,
  pathPreviewLanguage,
  renderContentPreview,
} from "./shared/preview-text";
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
import { countLabel, formatBytes } from "pi-cosmic-core/display";
import { previewIssuesSlot } from "../../preview/preview-issues";

export function createWritePreviewTool(cwd: string) {
  const originalWrite = createWriteToolDefinition(cwd);

  const { renderCall: _renderCall, renderResult: _renderResult, ...definition } = originalWrite;
  return {
    ...definition,
    execute(...args: Parameters<typeof originalWrite.execute>) {
      const [toolCallId, params, signal, , ctx] = args;
      const input = hostObject(params);
      const path = getPathArg(input);
      const content = ownField(input, "content");
      if (!path || !Predicate.isString(content) || !hasCodePreviewSessionCapability())
        return originalWrite.execute(...args);
      return executeWriteWithPreview(toolCallId, path, content, cwd, signal, ctx);
    },
  };
}

export function writePreviewRenderers(cwd: string): PreviewRenderers {
  return {
    renderCall(args, theme, renderContext) {
      const { state, expanded, invalidate } = renderContext;
      const input = hostObject(args);
      const path = getPathArg(input);
      const contentArg = ownField(input, "content");
      const content = Predicate.isString(contentArg) ? contentArg : "";
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
      container.addChild(
        stateHeading(() => (state.writeNewFile === true ? newHeader : existingHeader)),
      );
      container.addChild(previewIssuesSlot(renderContext));
      if (!expanded && !codePreviewSettings.writeContentPreview) {
        const hint = hiddenPreviewExpandHintForShell(state, theme, "content");
        if (hint) container.addChild(new Text(hint, 0, 0));
        return container;
      }
      const collapsedLines = codePreviewSettings.writeCollapsedLines;
      const owner = captureCodePreviewSessionCapability();
      const streaming = argumentsStreaming(renderContext);
      const previewKey = [
        ...previewCacheKey([content], path, expanded, theme, collapsedLines),
        streaming,
      ];
      const preview = () =>
        cachedPreview(state, "writeCallPreview", previewKey, () =>
          renderContentPreview({
            content,
            limit: expanded ? 0 : collapsedLines,
            lang:
              !streaming && owner !== undefined && owner === captureCodePreviewSessionCapability()
                ? lang
                : undefined,
            theme,
            invalidate,
            emptyLabel: "Empty content",
            skipHighlightLabel: "Syntax highlighting skipped for large content",
          }),
        );
      container.addChild(unlessResultDiffShown(state, preview));
      return container;
    },

    renderResult: (result, { expanded }, theme, renderContext) => {
      const { state, invalidate } = renderContext;
      setResultDiffShown(state, false);
      const firstText = getTextContent(result.content);
      if (renderContext.isError) {
        state.writeNewFile = false;
        return renderPreviewError(theme, expanded, firstText);
      }

      const input = hostObject(renderContext.args);
      const path = getPathArg(input);
      const before = writeBeforeSnapshot(
        state,
        renderContext.toolCallId,
        hostObject(result.details),
      );
      state.writeNewFile = isKnownNewWrite(before, hostContainer(result.details));
      const nextContent = ownField(input, "content");
      const plan = writeDiffPlan(before, Predicate.isString(nextContent) ? nextContent : undefined);
      if (plan.kind === "skipped")
        return plan.measured
          ? new Text(theme.fg("muted", `diff skipped: ${escapeControlChars(plan.reason)}`), 0, 0)
          : new Container();
      if (plan.kind === "unknown") return new Container();
      if (plan.kind === "unchanged") return new Text(theme.fg("muted", "no changes"), 0, 0);
      if (!expanded && !codePreviewSettings.writeContentPreview) return new Container();
      if (plan.kind === "guarded") return new Text(diffSkippedNote(theme, plan.guard), 0, 0);
      const { previous, content } = plan;
      setResultDiffShown(state, !expanded);
      const settings = codePreviewSettings;
      const render = (active: boolean) =>
        renderWriteDiffPreview(
          previous,
          content,
          path,
          expanded,
          theme,
          settings,
          active,
          invalidate,
        );
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
        previous.length + content.length,
        "Rendering write diff…",
        theme,
        render,
        invalidate,
        captureCodePreviewSessionCapability(),
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
  settings: CodePreviewSettings,
  active: boolean,
  invalidate?: () => void,
): FullWidthDiffText {
  const diff = createSimpleDiff(before, content);
  const summary = summarizeDiff(diff);
  const limit = diffPreviewLineLimit(summary.totalLines, expanded, settings.writeCollapsedLines);
  const header = `${theme.fg("muted", describeDiffContract(summary))}${diffSummarySeparator(theme)}${diffCounts(theme, summary)}\n`;
  const preview = formatDiffPreview(diff, pathPreviewLanguage(path, content), theme, limit, {
    totalLines: summary.totalLines,
    invalidate,
    highlight: active,
  });
  return new FullWidthDiffText(header + preview, theme, settings.diffIntensity);
}
