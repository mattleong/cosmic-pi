import * as Predicate from "effect/Predicate";
import {
  getLanguageFromPath,
  type AgentToolResult,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { CodePreviewRendererCallbacks } from "../../renderer-adapter";
import type { BuiltinCompactTool } from "../../builtin-subject";
import { getObjectValue } from "../../../shared/helpers";
import { escapeControlChars } from "../../../shared/terminal-text";
import { getEditPreviewOperations, getPathArg } from "../../data/args";
import { getEditDiff, getTextContent } from "../../data/results";
import { codePreviewSettings } from "../../../config/state";
import { renderHighlightedText } from "../../../syntax/render";
import { resolvePreviewLanguage } from "../../../syntax/language";
import { renderContentPreview } from "./content-preview";
import {
  oversizedReadNotice,
  splitListingNotice,
  splitShellNotice,
  withAgentNotes,
} from "./output-notice";
import { renderGrepOutputLines } from "../../grep-render";
import { createPathListRenderer } from "../../path-list-render";
import { FullWidthDiffText } from "../../../diff/full-width-text";
import { createSimpleDiff } from "../../../diff/structured";
import { summarizeDiff } from "../../../diff/summary";
import { formatDiffPreview } from "./diff-preview";
import { expandedSection } from "../../../preview/expanded-section";
import { normalizeShellCommandWhitespace } from "../../shell-command";
import { readResultBody } from "./read-result";
import type { RendererState, ToolRenderContext } from "./types";
import { writeBeforeSnapshot, writeDiffPlan } from "./write-result";

/** Detailed content only. The shared shell owns headings, outcome, and attention. */
export function builtinExpandedContent(
  tool: BuiltinCompactTool,
  cwd: string,
): NonNullable<CodePreviewRendererCallbacks["expandedContent"]> {
  return {
    renderCall(args, theme, context) {
      const path = getPathArg(args);
      const container = new Container();
      const operations = tool === "edit" ? getEditPreviewOperations(args) : [];
      const edits = getObjectValue(args, "edits");
      const completeEdits = Array.isArray(edits) && operations.length === edits.length;
      // The heading shows the target; list only the remaining options.
      const options = builtinOptionLabels(tool, args, completeEdits);
      if (options.length)
        container.addChild(
          expandedSection(theme, undefined, new Text(theme.fg("muted", options.join(" · ")), 0, 0)),
        );
      if (tool === "bash") {
        const command = getObjectValue(args, "command");
        if (Predicate.isString(command))
          container.addChild(
            expandedSection(theme, undefined, commandBody(command, theme, context.invalidate)),
          );
      } else if (tool === "write") {
        const content = getObjectValue(args, "content");
        if (Predicate.isString(content))
          container.addChild(
            expandedSection(theme, undefined, source(content, path, theme, context.invalidate)),
          );
      } else if (tool === "edit") {
        for (const operation of operations) {
          // The complete old/new source also preserves unchanged lines outside diff context.
          container.addChild(
            expandedSection(
              theme,
              "Old text",
              source(operation.oldText, path, theme, context.invalidate),
            ),
          );
          container.addChild(
            expandedSection(
              theme,
              "New text",
              source(operation.newText, path, theme, context.invalidate),
            ),
          );
        }
      }
      return container;
    },
    renderResult(result, _options, theme, context) {
      if (context.isError)
        return expandedSection(
          theme,
          "Error",
          new Text(theme.fg("error", escapeControlChars(getTextContent(result.content))), 0, 0),
        );
      return withAgentNotes(
        expandedSection(
          theme,
          undefined,
          builtinResultBody(tool, cwd, result, theme, {
            args: context.args,
            state: context.state,
            toolCallId: context.toolCallId,
            invalidate: context.invalidate,
          }),
        ),
        theme,
        splitAgentNotice(tool, result).notice,
      );
    },
  };
}

/**
 * Output without the recovery text Pi appends for the agent. Expansion keeps that text under its
 * own label rather than drawing it as file content or as an output line.
 */
function splitAgentNotice(tool: BuiltinCompactTool, result: AgentToolResult<unknown>) {
  const output = getTextContent(result.content);
  if (tool === "read") {
    const notice = oversizedReadNotice(result.details, output);
    return { output: notice === undefined ? output : "", notice };
  }
  if (tool !== "bash" && tool !== "grep" && tool !== "find" && tool !== "ls")
    return { output, notice: undefined };
  const split = (tool === "bash" ? splitShellNotice : splitListingNotice)(output.split("\n"));
  return split.notice === undefined
    ? { output, notice: undefined }
    : { output: split.lines.join("\n"), notice: split.notice };
}

function builtinResultBody(
  tool: BuiltinCompactTool,
  cwd: string,
  result: AgentToolResult<unknown>,
  theme: Theme,
  context: Pick<
    ToolRenderContext<RendererState, unknown>,
    "args" | "state" | "toolCallId" | "invalidate"
  >,
): Component {
  const output = getTextContent(result.content);
  const path = getPathArg(context.args);
  if (tool === "read") {
    const body = readResultBody(result, context.args);
    // Images remain Pi-owned, including mixed image/text results.
    if (body.kind === "image") return new Text(escapeControlChars(body.text), 0, 0);
    // The agent's notes carry an oversized line's recovery instruction.
    if (body.kind === "oversized") return new Container();
    return source(body.content, path, theme, context.invalidate, body.firstLine);
  }
  if (tool === "edit") {
    const diff = getEditDiff(result.details);
    const content = new Container();
    if (diff) content.addChild(renderDiff(diff, path, theme, context.invalidate));
    if (output) content.addChild(rawResult(output, theme));
    return content;
  }
  if (tool === "write") {
    const plan = writeDiffPlan(
      writeBeforeSnapshot(context.state, context.toolCallId, result.details),
      getObjectValue(context.args, "content"),
    );
    const body = new Container();
    if (plan.kind === "skipped" && plan.measured)
      body.addChild(new Text(theme.fg("muted", escapeControlChars(plan.reason)), 0, 0));
    if (plan.kind === "diff")
      body.addChild(
        renderDiff(createSimpleDiff(plan.previous, plan.content), path, theme, context.invalidate),
      );
    if (output) body.addChild(rawResult(output, theme));
    return body;
  }
  // Pi's trailing notice for the agent follows the body under its own label.
  const shown = splitAgentNotice(tool, result).output;
  const pattern = getObjectValue(context.args, "pattern");
  if (tool === "grep")
    return new Text(
      renderGrepOutputLines(
        shown,
        theme,
        {
          pattern: Predicate.isString(pattern) ? pattern : "",
          literal: getObjectValue(context.args, "literal") === true,
          ignoreCase: getObjectValue(context.args, "ignoreCase") === true,
        },
        context.invalidate,
      ).join("\n"),
      0,
      0,
    );
  if (tool === "find" || tool === "ls") {
    const pathList = createPathListRenderer(shown.split("\n"), cwd, theme, {
      iconMode: codePreviewSettings.pathIcons,
    });
    return new Text(pathList.renderChunk(pathList.lines).join("\n"), 0, 0);
  }
  return new Text(escapeControlChars(shown), 0, 0);
}

/** Values the heading shows exactly: short, single-spaced, and free of control characters. */
function headingShowsExactly(value: string): boolean {
  return (
    value.length <= 60 &&
    value === normalizeShellCommandWhitespace(value) &&
    value === escapeControlChars(value)
  );
}

/**
 * Arguments the heading cannot show exactly, as short labels. Values are never collapsed or
 * clipped: expansion must preserve the exact input.
 */
function builtinOptionLabels<Args>(
  tool: BuiltinCompactTool,
  args: Args,
  completeEdits: boolean,
): string[] {
  const shown = new Set<string>();
  if (tool === "bash") shown.add("command");
  if (tool === "write") shown.add("content");
  if (tool === "read") shown.add("offset").add("limit");
  if (tool === "edit" && completeEdits) shown.add("edits").add("oldText").add("newText");
  const target = new Set([
    "path",
    "file_path",
    ...(tool === "grep" || tool === "find" ? ["pattern"] : []),
  ]);
  return Object.entries(args ?? {}).flatMap(([key, value]) => {
    if (shown.has(key) || value === undefined || value === false || value === null) return [];
    if (target.has(key) && Predicate.isString(value) && headingShowsExactly(value)) return [];
    if (value === true) return [key];
    const text =
      Predicate.isNumber(value) || (Predicate.isString(value) && headingShowsExactly(value))
        ? String(value)
        : (JSON.stringify(value) ?? "");
    return [`${key} ${escapeControlChars(text)}`];
  });
}

function commandBody(command: string, theme: Theme, invalidate?: () => void): Component {
  // The heading normalizes whitespace, so only an already-normal command appears there exactly.
  const exactInHeading = normalizeShellCommandWhitespace(command) === command;
  let highlighted: Text | undefined;
  return {
    render(width) {
      // Leave room for the heading's icon, tool name, and a counter or timing.
      if (exactInHeading && visibleWidth(command) <= width - 30) return [];
      highlighted ??= new Text(
        renderHighlightedText(command, "bash", theme, invalidate).join("\n"),
        0,
        0,
      );
      return highlighted.render(width);
    },
    invalidate: () => {
      highlighted = undefined;
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
      firstLine,
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
