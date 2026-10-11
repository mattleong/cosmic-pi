import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  escapeControlChars,
  getTextContent,
  type CodePreviewShellOptions,
  type CompactSummary,
  type CompactSummaryProvider,
} from "pi-code-previews";
import { safeTextPrefix, sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core";
import { canonicalResultJson } from "../domain/result-contract.ts";
import { rejectedCallIssue } from "./compact-action-failures.ts";
import { errorSection, previewCall, type PreviewRenderContext } from "./render-preview.ts";

export const RESULT_TOOL_LABEL = "Subagent Result";
export const RESULT_ACCEPTED_TEXT = "Result accepted as your return value. Stop now.";
const SUBJECT_CHARS = 120;

const decodeJson = Schema.decodeUnknownOption(Schema.Json);

const submittedJson = <Args>(args: Args): string | undefined =>
  Option.getOrUndefined(Option.map(decodeJson(args), canonicalResultJson));

const submittedValue = <Args>(args: Args, theme: Theme): Component =>
  new Text(theme.fg("toolOutput", escapeControlChars(JSON.stringify(args ?? null, null, 2))), 0, 0);

const rejection = <Details>(result: AgentToolResult<Details>, theme: Theme): Component =>
  errorSection(theme, stripTerminalControls(getTextContent(result.content)));

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

export const resultExpandedContent = {
  renderCall: <Args>(args: Args, theme: Theme) => submittedValue(args, theme),
  renderResult: (result, _options, theme, context) =>
    context.isError ? rejection(result, theme) : new Container(),
} satisfies NonNullable<CodePreviewShellOptions["expandedContent"]>;

export const resultToolRenderers = {
  renderCall<Args>(args: Args, theme: Theme, context: PreviewRenderContext): Component {
    return previewCall(
      theme,
      context,
      { title: RESULT_TOOL_LABEL, subtitle: submittedJson(args) ?? "" },
      context.expanded ? submittedValue(args, theme) : undefined,
    );
  },
  renderResult<Details>(
    result: AgentToolResult<Details>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: PreviewRenderContext,
  ): Component {
    if (context.isError) return options.expanded ? rejection(result, theme) : new Container();
    const text = getTextContent(result.content);
    if (!options.expanded && text === RESULT_ACCEPTED_TEXT) return new Container();
    return new Text(theme.fg("toolOutput", escapeControlChars(text)), 0, 0);
  },
};
