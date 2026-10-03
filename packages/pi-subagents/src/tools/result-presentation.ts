/**
 * Presentation of a local Pi child's private `subagent_result` tool: its compact summary,
 * content-only expansion, and preview-style bodies. The shared shell draws rejection issues.
 */
import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  expandedSection,
  getTextContent,
  type CodePreviewShellOptions,
  type CompactSummary,
  type CompactSummaryProvider,
} from "pi-code-previews";
import { sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core";
import { renderToolHeader, toolRunningLine } from "pi-cosmic-ui/tool";
import { canonicalResultJson } from "../domain/result-contract.ts";
import { safeTextPrefix } from "../run/state.ts";
import { rejectedCallIssue } from "./compact-action-failures.ts";

export const RESULT_TOOL_LABEL = "Subagent Result";
/** The child result tool's receipt for a value the parent accepted. */
export const RESULT_ACCEPTED_TEXT = "Result accepted as your return value. Stop now.";
const SUBJECT_CHARS = 120;

const decodeJson = Schema.decodeUnknownOption(Schema.Json);

/** The submitted value as one canonical JSON line, when the arguments are JSON. */
const submittedJson = <Args>(args: Args): string | undefined =>
  Option.getOrUndefined(Option.map(decodeJson(args), canonicalResultJson));

/** The whole value, indented, for expanded views; the heading shows only one bounded line. */
const submittedValue = <Args>(args: Args, theme: Theme): Component =>
  new Text(
    theme.fg("toolOutput", stripTerminalControls(JSON.stringify(args ?? null, null, 2))),
    0,
    0,
  );

const errorSection = <Details>(result: AgentToolResult<Details>, theme: Theme): Component =>
  expandedSection(
    theme,
    "Error",
    new Text(theme.fg("toolOutput", stripTerminalControls(getTextContent(result.content))), 0, 0),
  );

/**
 * The submitted value heads the row, an exact acceptance receipt is a success, and a rejection
 * explains itself. Any other result declines, so its text stays verbatim.
 */
export const resultCompactSummary: CompactSummaryProvider<unknown, unknown, unknown> = ({
  args,
  result,
  phase,
  context,
}) => {
  const json = submittedJson(args);
  if (json === undefined) return undefined;
  const summary: CompactSummary = {
    subject: safeTextPrefix(sanitizeTerminalLine(json), SUBJECT_CHARS),
  };
  if (!result) return phase === "settled" || context.isError ? undefined : summary;
  const text = getTextContent(result.content);
  if (context.isError)
    return phase === "settled"
      ? {
          ...summary,
          outcome: "error",
          issues: [rejectedCallIssue("return the result to", text, "the program")],
        }
      : undefined;
  return text === RESULT_ACCEPTED_TEXT
    ? { ...summary, counters: ["accepted"], outcome: "success" }
    : undefined;
};

/** The whole submitted value and a rejection's own text; `accepted` is the receipt. */
export const resultExpandedContent: NonNullable<CodePreviewShellOptions["expandedContent"]> = {
  renderCall: (args, theme) => submittedValue(args, theme),
  renderResult: (result, _options, theme, context) =>
    context.isError ? errorSection(result, theme) : new Container(),
};

/** The parts of Pi's render context these bodies read. */
interface ResultRenderContext {
  readonly expanded: boolean;
  readonly executionStarted: boolean;
  readonly isPartial: boolean;
  readonly isError: boolean;
}

/** Preview-style call and result bodies. */
export const resultToolRenderers = {
  renderCall<Args>(args: Args, theme: Theme, context: ResultRenderContext): Component {
    const json = submittedJson(args);
    const container = new Container();
    container.addChild(
      new Text(renderToolHeader({ title: RESULT_TOOL_LABEL, subtitle: json ?? "" }, theme), 0, 0),
    );
    // The heading shows one bounded line; the expanded view shows the whole value.
    if (context.expanded) container.addChild(submittedValue(args, theme));
    if (context.executionStarted && context.isPartial)
      container.addChild(new Text(toolRunningLine(theme), 0, 0));
    return container;
  },
  renderResult<Details>(
    result: AgentToolResult<Details>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: ResultRenderContext,
  ): Component {
    if (context.isError) return options.expanded ? errorSection(result, theme) : new Container();
    const text = getTextContent(result.content);
    // The receipt tells the agent to stop; collapsed rows leave that to Pi's success background.
    if (!options.expanded && text === RESULT_ACCEPTED_TEXT) return new Container();
    return new Text(theme.fg("toolOutput", stripTerminalControls(text)), 0, 0);
  },
};
