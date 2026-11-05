import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Rec from "effect/Record";
import { receivedArguments } from "../../argument-failure";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import type { BuiltinCompactTool } from "../../builtin-subject";
import {
  hostObject,
  ownField,
  type HostObject,
  hostValue,
  type HostValue,
} from "../../../shared/untrusted-value";
import { escapeControlChars } from "../../../shared/terminal-text";
import {
  editOperationInputs,
  getEditOperations,
  getEditPreviewOperations,
  getPathArg,
  numericArg,
  stringArg,
} from "../../data/args";
import { getEditDiff, getTextContent } from "../../data/results";
import { codePreviewSettings } from "../../../config/state";
import { renderHighlightedText } from "../../../syntax/render";
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
import { expandedFields, type ExpandedField } from "../../../preview/expanded-body";
import {
  headingCounter,
  headingIsOwnCall,
  headingShowedSubject,
} from "../../../preview/heading-coverage";
import { normalizeShellCommandWhitespace } from "../../shell-command";
import { argumentsStreaming, pathPreviewLanguage, renderContentPreview } from "./preview-text";
import { readResultBody } from "./read-result";
import { cachedDeferredPreview } from "./cache";
import { captureCodePreviewSessionCapability } from "../../../application/capability";
import type { PreviewRenderers, RendererState, ToolRenderContext } from "./types";
import { writeBeforeSnapshot, writeDiffPlan } from "./write-result";
import { editDiffShowsOperations, writeDiffShowsContent } from "./edit-diff-coverage";
import { withoutReportedShellStatus } from "../../builtin-failure-shell";
import { PATH_LIST_EMPTY_OUTPUT } from "../../builtin-result-detail";

export function builtinExpandedContent(tool: BuiltinCompactTool, cwd: string): PreviewRenderers {
  return {
    renderCall(args, theme, context) {
      const input = hostObject(args);
      const path = getPathArg(input);
      const container = new Container();
      // Expansion shows every requested replacement, even one that would change nothing.
      const operations = tool === "edit" ? getEditOperations(input) : [];
      const completeEdits =
        tool === "edit" && operations.length === editOperationInputs(input).length;
      const options = builtinOptionFields(tool, hostValue(args), completeEdits);
      if (options.length) container.addChild(optionFields(theme, options, context.state));
      const command = ownField(input, "command");
      if (tool === "bash" && Predicate.isString(command))
        container.addChild(
          expandedSection(
            theme,
            undefined,
            commandBody(command, theme, context.state, context.invalidate),
          ),
        );
      const highlight = !argumentsStreaming(context);
      const content = ownField(input, "content");
      if (tool === "write" && Predicate.isString(content))
        container.addChild(
          unlessCallShownByResult(
            context.state,
            expandedSection(
              theme,
              undefined,
              source(content, path, theme, context.invalidate, { highlight }),
            ),
          ),
        );
      const requested = new Container();
      for (const { oldText, newText } of operations)
        for (const [label, text] of [
          ["Old text", oldText],
          ["New text", newText],
        ] as const)
          requested.addChild(
            expandedSection(
              theme,
              label,
              text === ""
                ? new Text(theme.fg("muted", "empty"), 0, 0)
                : source(text, path, theme, context.invalidate, { highlight }),
            ),
          );
      if (operations.length) container.addChild(unlessCallShownByResult(context.state, requested));
      return container;
    },
    renderResult(result, _options, theme, context) {
      context.state[CALL_SHOWN_BY_RESULT] = false;
      if (tool === "edit") context.state[CALL_SHOWN_BY_RESULT] = editDiffShown(result, context);
      if (context.isError) {
        const text = getTextContent(result.content);
        // The issue and its detail state Pi's rejection; only arguments the call doesn't show remain.
        const received = receivedArguments(text);
        if (received !== undefined)
          return received && !hasArguments(hostObject(context.args))
            ? expandedSection(
                theme,
                "Received arguments",
                new Text(theme.fg("error", escapeControlChars(received)), 0, 0),
              )
            : new Container();
        // The issue already states a shell's exit status, as the preview style does.
        const shown =
          tool === "bash"
            ? Str.trimEnd(Arr.join(withoutReportedShellStatus(Str.split(text, "\n")), "\n"))
            : text;
        return shown
          ? expandedSection(
              theme,
              tool === "bash" ? "Output" : "Error",
              new Text(theme.fg("error", escapeControlChars(shown)), 0, 0),
            )
          : new Container();
      }
      const { output, notice } = splitAgentNotice(tool, result);
      const body = builtinResultBody(tool, cwd, result, output, theme, context);
      const raw = unconfirmedResultText(tool, output);
      // Once the body has a second kind of content, each kind is labeled.
      const label =
        (notice !== undefined || raw !== undefined) && (tool !== "read" || output !== "")
          ? RESULT_LABELS[tool]
          : undefined;
      const container = new Container();
      container.addChild(expandedSection(theme, label, body));
      if (raw !== undefined)
        container.addChild(
          expandedSection(theme, "Raw result", new Text(escapeControlChars(raw), 0, 0)),
        );
      return withAgentNotes(container, theme, notice);
    },
  };
}

function splitAgentNotice(tool: BuiltinCompactTool, result: AgentToolResult<unknown>) {
  const output = getTextContent(result.content);
  // An oversized first line's notice is its issue's detail, so it isn't repeated as notes.
  if (tool === "read") {
    const notice = oversizedReadNotice(hostObject(result.details), output);
    return { output: notice === undefined ? output : "", notice: undefined };
  }
  if (tool === "edit" || tool === "write") return { output, notice: undefined };
  const split = (tool === "bash" ? splitShellNotice : splitListingNotice)(Str.split(output, "\n"));
  return { output: Arr.join(split.lines, "\n"), notice: split.notice };
}

function builtinResultBody(
  tool: BuiltinCompactTool,
  cwd: string,
  result: AgentToolResult<unknown>,
  output: string,
  theme: Theme,
  context: Pick<
    ToolRenderContext<RendererState, unknown>,
    "args" | "state" | "toolCallId" | "invalidate"
  >,
): Component {
  const input = hostObject(context.args);
  const path = getPathArg(input);
  if (tool === "read") {
    const body = readResultBody(result, input);
    if (body.kind === "image") return new Text(escapeControlChars(body.text), 0, 0);
    if (body.kind === "oversized") return new Container();
    const { content, firstLine } = body;
    // A full file can be large, so it draws after deferred work, as the preview style's does.
    return deferredBody(
      context,
      "readExpandedContent",
      [content, path, firstLine],
      theme,
      (active) =>
        source(content, path, theme, context.invalidate, { firstLine, highlight: active }),
    );
  }
  if (tool === "edit") {
    const diff = getEditDiff(hostObject(result.details));
    const content = new Container();
    if (diff) content.addChild(renderDiff(diff, path, theme, context.invalidate));
    return content;
  }
  if (tool === "write") return writeResultBody(result, theme, context, input, path);
  if (tool === "grep")
    return deferredBody(
      context,
      "grepExpandedContent",
      [output, input],
      theme,
      () =>
        new Text(
          Arr.join(renderGrepOutputLines(output, theme, input, context.invalidate), "\n"),
          0,
          0,
        ),
    );
  if (tool === "find" || tool === "ls") {
    // An empty listing's note is not a path, so it gets no path marker.
    if (Str.trim(output) === PATH_LIST_EMPTY_OUTPUT[tool])
      return new Text(theme.fg("muted", PATH_LIST_EMPTY_OUTPUT[tool]), 0, 0);
    const pathList = createPathListRenderer(
      Str.split(output, "\n"),
      cwd,
      theme,
      codePreviewSettings.pathIcons,
    );
    return new Text(Arr.join(pathList.renderChunk(pathList.lines), "\n"), 0, 0);
  }
  // A command's final newline would otherwise draw an empty row at the end of its output.
  return new Text(escapeControlChars(Str.trimEnd(output)), 0, 0);
}

function deferredBody(
  context: Pick<ToolRenderContext<RendererState, unknown>, "state" | "invalidate">,
  slot: string,
  dependencies: readonly unknown[],
  theme: Theme,
  render: (active: boolean) => Component,
): Component {
  const characters = Arr.reduce(dependencies, 0, (total, value) =>
    Predicate.isString(value) ? total + value.length : total,
  );
  return cachedDeferredPreview(
    context.state,
    slot,
    [...dependencies, theme],
    characters,
    "Rendering…",
    theme,
    render,
    context.invalidate,
    captureCodePreviewSessionCapability(),
  );
}

function writeResultBody(
  result: AgentToolResult<unknown>,
  theme: Theme,
  context: Pick<ToolRenderContext<RendererState, unknown>, "state" | "toolCallId" | "invalidate">,
  input: HostObject | undefined,
  path: string,
): Component {
  const content = ownField(input, "content");
  const plan = writeDiffPlan(
    writeBeforeSnapshot(context.state, context.toolCallId, hostObject(result.details)),
    Predicate.isString(content) ? content : undefined,
  );
  const body = new Container();
  if (plan.kind === "skipped" && plan.measured)
    body.addChild(new Text(theme.fg("muted", escapeControlChars(plan.reason)), 0, 0));
  if (plan.kind === "diff") {
    context.state[CALL_SHOWN_BY_RESULT] = writeDiffShowsContent(plan.previous, plan.content);
    body.addChild(
      renderDiff(createSimpleDiff(plan.previous, plan.content), path, theme, context.invalidate),
    );
  }
  return body;
}

// Pi's confirmations restate the success the heading shows; any other result text stays visible.
const EDIT_SUCCESS = /^Successfully replaced (?:\d+ block\(s\)|text) in [^\n]+\.$/u;
const WRITE_SUCCESS = /^Successfully wrote (?:\d+ bytes )?to [^\n]+$/u;

// Set by the result slot when its diff shows every line of the call's content.
const CALL_SHOWN_BY_RESULT = "codePreviewCallShownByResult";

function editDiffShown(
  result: AgentToolResult<unknown>,
  context: Pick<ToolRenderContext<RendererState, unknown>, "args" | "isError">,
): boolean {
  if (context.isError) return false;
  const diff = getEditDiff(hostObject(result.details));
  return (
    diff !== undefined &&
    editDiffShowsOperations(diff, getEditPreviewOperations(hostObject(context.args)))
  );
}

/** Call content, unless the result's diff already shows every line of it. */
function unlessCallShownByResult(state: RendererState, content: Component): Component {
  return {
    render: (width) => (state[CALL_SHOWN_BY_RESULT] === true ? [] : content.render(width)),
    invalidate: () => content.invalidate(),
  };
}

function headingShowsExactly(value: string): boolean {
  return (
    value.length <= 60 &&
    value === normalizeShellCommandWhitespace(value) &&
    value === escapeControlChars(value)
  );
}

const hasArguments = (input: HostObject | undefined): boolean =>
  input !== undefined && Rec.keys(input).length > 0;

/** An argument's name as a field label: `file_path` and `ignoreCase` read `File path`, `Ignore case`. */
function fieldLabel(key: string): string {
  const words = Str.toLowerCase(
    Str.trim(Str.replace(/[_\s]+/gu, " ")(Str.replace(/(?<=\p{Ll})(?=\p{Lu})/gu, " ")(key))),
  );
  return `${Str.toUpperCase(Str.slice(0, 1)(words))}${Str.slice(1)(words)}`;
}

interface OptionField extends ExpandedField {
  /** The call's target, which a heading that shows its whole subject already states. */
  readonly target: boolean;
  /** An option the tool's own preview heading states exactly, such as grep's glob and limit. */
  readonly previewHeading: boolean;
  /** The heading counter that states this option, such as `limit reached: 2` for a limit. */
  readonly counter?: string | undefined;
}

/**
 * Labeled argument fields, without the target once the heading has shown the whole subject, and
 * without options the tool's own preview heading or the compact heading's counter states.
 */
function optionFields(
  theme: Theme,
  fields: readonly OptionField[],
  state: RendererState,
): Component {
  let drawn:
    | {
        readonly targets: boolean;
        readonly own: boolean;
        readonly counter: string | undefined;
        readonly body: Component;
      }
    | undefined;
  return {
    render(width) {
      const targets = !headingShowedSubject(state);
      const own = headingIsOwnCall(state);
      const counter = own ? undefined : headingCounter(state);
      if (drawn?.targets !== targets || drawn.own !== own || drawn.counter !== counter)
        drawn = {
          targets,
          own,
          counter,
          body: expandedFields(
            theme,
            Arr.filter(
              fields,
              (field) =>
                (targets || !field.target) &&
                !(own && field.previewHeading) &&
                (field.counter === undefined || field.counter !== counter),
            ),
          ),
        };
      return drawn.body.render(width);
    },
    invalidate: () => {
      drawn = undefined;
    },
  };
}

/** Arguments the heading and bodies don't show, as labeled fields. */
function builtinOptionFields(
  tool: BuiltinCompactTool,
  args: HostValue | undefined,
  completeEdits: boolean,
): OptionField[] {
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
  // @effect-diagnostics-next-line preferEffectRecord:off -- args is an untyped host value that need not be a record.
  return Arr.flatMap(Object.entries(args ?? {}), ([key, value]): OptionField[] => {
    if (shown.has(key) || value === undefined || value === false || value === null) return [];
    const isTarget = target.has(key) && Predicate.isString(value);
    if (isTarget && headingShowsExactly(value)) return [];
    const text =
      value === true
        ? "yes"
        : Predicate.isString(value) || Predicate.isNumber(value)
          ? String(value)
          : (JSON.stringify(value) ?? "");
    return [
      {
        label: fieldLabel(key),
        lines: [text],
        target: isTarget,
        previewHeading: previewHeadingStates(tool, key, hostObject(args)),
        counter: limitCounter(tool, key, Predicate.isNumber(value) ? value : undefined),
      },
    ];
  });
}

/** The counter a listing's compact heading shows when the limit this option set was reached. */
function limitCounter(
  tool: BuiltinCompactTool,
  key: string,
  value: number | undefined,
): string | undefined {
  if (key !== "limit" || value === undefined) return undefined;
  return tool === "grep" || tool === "find" || tool === "ls"
    ? `limit reached: ${value}`
    : undefined;
}

/** Whether the tool's own preview heading states an option, as grep's glob and a listing's limit. */
function previewHeadingStates(
  tool: BuiltinCompactTool,
  key: string,
  args: HostObject | undefined,
): boolean {
  if (tool !== "grep" && tool !== "find" && tool !== "ls") return false;
  if (key === "glob") return tool === "grep" && stringArg(args, "glob") !== "";
  return key === "limit" && Boolean(numericArg(args, "limit"));
}

function commandBody(
  command: string,
  theme: Theme,
  state: RendererState,
  invalidate?: () => void,
): Component {
  // The heading's subject is this command exactly unless display normalization changed it.
  const headingSubject =
    command.length <= 4096 &&
    escapeControlChars(normalizeShellCommandWhitespace(command)) === command;
  let highlighted: Text | undefined;
  return {
    render(width) {
      if (headingSubject && headingShowedSubject(state)) return [];
      highlighted ??= new Text(
        Arr.join(renderHighlightedText(command, "bash", theme, invalidate), "\n"),
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
  {
    firstLine,
    highlight = true,
  }: { readonly firstLine?: number | undefined; readonly highlight?: boolean } = {},
): Component {
  return renderContentPreview({
    content,
    limit: 0,
    lang: highlight ? pathPreviewLanguage(path, content) : undefined,
    theme,
    invalidate,
    firstLine,
    emptyLabel: "",
    skipHighlightLabel: "Syntax highlighting skipped for large content",
  });
}

function renderDiff(
  diff: string,
  path: string,
  theme: Theme,
  invalidate?: () => void,
): FullWidthDiffText {
  const { totalLines } = summarizeDiff(diff);
  return new FullWidthDiffText(
    formatDiffPreview(diff, pathPreviewLanguage(path), theme, totalLines, {
      totalLines,
      invalidate,
    }),
    theme,
  );
}

const RESULT_LABELS = {
  bash: "Output",
  read: "Content",
  write: "Diff",
  edit: "Diff",
  grep: "Matches",
  find: "Paths",
  ls: "Entries",
} as const satisfies Record<BuiltinCompactTool, string>;

/** Result text from an edit or write other than Pi's confirmation, which the heading restates. */
function unconfirmedResultText(tool: BuiltinCompactTool, output: string): string | undefined {
  if (!output) return undefined;
  if (tool === "edit") return EDIT_SUCCESS.test(output) ? undefined : output;
  if (tool === "write") return WRITE_SUCCESS.test(output) ? undefined : output;
  return undefined;
}
