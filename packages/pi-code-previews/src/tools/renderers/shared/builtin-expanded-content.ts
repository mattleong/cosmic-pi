import * as Predicate from "effect/Predicate";
import { getLanguageFromPath, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { AdaptableToolDefinition, CodePreviewToolRenderers } from "../../renderer-adapter";
import type { BuiltinCompactTool } from "../../builtin-subject";
import { getObjectValue } from "../../../shared/helpers";
import { writeDiffProjection } from "../../compact-notices";
import { escapeControlChars } from "../../../shared/terminal-text";
import { getEditPreviewOperations, getPathArg, getReadStartLine } from "../../data/args";
import { getEditDiff, getTextContent } from "../../data/results";
import { codePreviewSettings } from "../../../config/state";
import { renderHighlightedText } from "../../../syntax/render";
import { resolvePreviewLanguage } from "../../../syntax/language";
import { renderContentPreview } from "./content-preview";
import { renderGrepOutputLines } from "../../grep-render";
import { createPathListChunkRenderer } from "../../path-list-render";
import { FullWidthDiffText } from "../../../diff/full-width-text";
import { createSimpleDiff } from "../../../diff/structured";
import { summarizeDiff } from "../../../diff/summary";
import { formatDiffPreview } from "./diff-preview";
import { getCodePreviewBeforeWrite } from "../../../write/preview-execution";
import {
  getWriteDiffSkipReason,
  shouldSkipWriteDiffBytes,
  shouldSkipWriteDiffComplexity,
} from "../../../write/diff";

/** Detailed content only. The shared shell owns headings, outcome, and attention. */
export function builtinExpandedContent<T extends AdaptableToolDefinition>(
  tool: BuiltinCompactTool,
  cwd: string,
): Pick<CodePreviewToolRenderers<T>, "renderCall" | "renderResult"> {
  return {
    renderCall(args, theme, context) {
      const path = getPathArg(args);
      const container = new Container();
      // Keep full arguments available even when the semantic target is elided.
      const sourceKey = tool === "bash" ? "command" : tool === "write" ? "content" : undefined;
      const operations = tool === "edit" ? getEditPreviewOperations(args) : [];
      const edits = getObjectValue(args, "edits");
      const completeEdits = Array.isArray(edits) && operations.length === edits.length;
      const entries = Object.entries(args ?? {}).filter(
        ([key, value]) =>
          !(key === sourceKey && Predicate.isString(value)) &&
          !(tool === "edit" && completeEdits && key === "edits"),
      );
      if (entries.length)
        container.addChild(
          new Text(escapeControlChars(JSON.stringify(Object.fromEntries(entries), null, 2)), 0, 0),
        );
      if (tool === "bash") {
        const command = getObjectValue(args, "command");
        if (Predicate.isString(command))
          container.addChild(
            new Text(
              renderHighlightedText(command, "bash", theme, context.invalidate).join("\n"),
              0,
              0,
            ),
          );
      } else if (tool === "write") {
        const content = getObjectValue(args, "content");
        if (Predicate.isString(content))
          container.addChild(source(content, path, theme, context.invalidate));
      } else if (tool === "edit") {
        for (const operation of getEditPreviewOperations(args)) {
          // The complete old/new source also preserves unchanged lines outside diff context.
          container.addChild(new Text(theme.fg("muted", "Old text"), 0, 0));
          container.addChild(source(operation.oldText, path, theme, context.invalidate));
          container.addChild(new Text(theme.fg("muted", "New text"), 0, 0));
          container.addChild(source(operation.newText, path, theme, context.invalidate));
        }
      }
      return container;
    },
    renderResult(result, _options, theme, context) {
      const output = getTextContent(result.content);
      const path = getPathArg(context.args);
      if (context.isError) return new Text(theme.fg("error", escapeControlChars(output)), 0, 0);
      if (tool === "read") {
        // Images remain Pi-owned, including mixed image/text results.
        if (result.content.some((part: { type: string }) => part.type === "image"))
          return new Text(escapeControlChars(output), 0, 0);
        return source(
          output,
          path,
          theme,
          context.invalidate,
          codePreviewSettings.readLineNumbers ? getReadStartLine(context.args) : undefined,
        );
      }
      if (tool === "edit") {
        const diff = getEditDiff(result.details);
        const content = new Container();
        if (diff) content.addChild(renderDiff(diff, path, theme, context.invalidate));
        if (output) content.addChild(rawResult(output, theme));
        return content;
      }
      if (tool === "write") {
        const before = Object.hasOwn(context.state, "codePreviewWriteBeforeSnapshot")
          ? context.state.codePreviewWriteBeforeSnapshot
          : getCodePreviewBeforeWrite(context.toolCallId, result.details);
        const previous = getObjectValue(before, "content");
        const content = getObjectValue(context.args, "content");
        const body = new Container();
        const skipReason = Predicate.isString(content)
          ? getWriteDiffSkipReason(before, content)
          : undefined;
        if (
          skipReason &&
          Predicate.isString(content) &&
          writeDiffProjection(before, content).metadata.length
        )
          body.addChild(new Text(theme.fg("muted", escapeControlChars(skipReason)), 0, 0));
        if (
          Predicate.isString(previous) &&
          Predicate.isString(content) &&
          previous !== content &&
          !getWriteDiffSkipReason(before, content) &&
          !shouldSkipWriteDiffBytes(previous, content) &&
          !shouldSkipWriteDiffComplexity(previous, content)
        )
          body.addChild(
            renderDiff(createSimpleDiff(previous, content), path, theme, context.invalidate),
          );
        if (output) body.addChild(rawResult(output, theme));
        return body;
      }
      if (tool === "grep")
        return new Text(
          renderGrepOutputLines(
            output,
            theme,
            {
              pattern: Predicate.isString(context.args?.pattern) ? context.args.pattern : "",
              literal: context.args?.literal === true,
              ignoreCase: context.args?.ignoreCase === true,
            },
            context.invalidate,
          ).join("\n"),
          0,
          0,
        );
      if (tool === "find" || tool === "ls") {
        const lines = output.split("\n");
        return new Text(
          createPathListChunkRenderer(lines, cwd, theme, {
            iconMode: codePreviewSettings.pathIcons,
          })(lines).join("\n"),
          0,
          0,
        );
      }
      return new Text(escapeControlChars(output), 0, 0);
    },
  };
}

function source(
  content: string,
  path: string,
  theme: Theme,
  invalidate?: () => void,
  firstLine?: number,
): Text {
  return new Text(
    renderContentPreview({
      content,
      limit: 0,
      lang: resolvePreviewLanguage({ path, content, piLanguage: getLanguageFromPath(path) }),
      theme,
      invalidate,
      lineNumbers: firstLine === undefined ? undefined : { firstLine },
      emptyLabel: "",
      skipHighlightLabel: "Syntax highlighting skipped for large content",
    }).text,
    0,
    0,
  );
}

function renderDiff(
  diff: string,
  path: string,
  theme: Theme,
  invalidate?: () => void,
): FullWidthDiffText {
  const summary = summarizeDiff(diff);
  return new FullWidthDiffText(
    formatDiffPreview(
      diff,
      resolvePreviewLanguage({ path, piLanguage: getLanguageFromPath(path) }),
      theme,
      summary.totalLines,
      {
        totalLines: summary.totalLines,
        hiddenLineNoun: "diff lines",
        skipHighlightLabel: "Syntax highlighting skipped for large diff",
        invalidate,
      },
    ),
    theme,
  );
}

function rawResult(output: string, theme: Theme): Text {
  return new Text(`${theme.fg("muted", "Raw result")}\n${escapeControlChars(output)}`, 0, 0);
}
