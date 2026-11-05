import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { expandedSection, isRejectedEmptyCall, receivedArguments } from "pi-code-previews";
import {
  renderExpansionAffordance,
  renderToolHeader,
  toolRunningLine,
  type ToolHeader,
} from "pi-cosmic-ui/tool";

interface PreviewRenderContext {
  readonly expanded: boolean;
  readonly executionStarted: boolean;
  readonly isPartial: boolean;
  readonly isError: boolean;
}

type RenderCall<Params extends TSchema> = NonNullable<ToolDefinition<Params>["renderCall"]>;

/** A call Pi rejected for malformed JSON arrives as `{}`, so its heading names only the tool. */
export const rejectionAwareCall =
  <Params extends TSchema>(label: string, renderCall: RenderCall<Params>): RenderCall<Params> =>
  (args, theme, context) =>
    isRejectedEmptyCall(context)
      ? new Text(renderToolHeader({ title: label }, theme), 0, 0)
      : renderCall(args, theme, context);

/**
 * A failure's expanded body. Pi's own argument rejection is stated by its issue, so, as for a
 * rejected builtin, only the arguments it echoed remain, and only when the call shows none of its
 * own (malformed JSON arrives as `{}`).
 */
const isArgumentRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

export const errorSection = (theme: Theme, text: string, args?: unknown): Component => {
  const callHasArguments = isArgumentRecord(args) && Rec.keys(args).length > 0;
  const received = receivedArguments(text);
  if (received === undefined)
    return expandedSection(theme, "Error", new Text(theme.fg("toolOutput", text), 0, 0));
  return received && !callHasArguments
    ? expandedSection(theme, "Received arguments", new Text(theme.fg("error", received), 0, 0))
    : new Container();
};

export const previewCall = (
  theme: Theme,
  context: PreviewRenderContext,
  header: ToolHeader,
  content?: Component,
): Component => {
  const container = new Container();
  container.addChild(new Text(renderToolHeader(header, theme), 0, 0));
  if (content) container.addChild(content);
  if (context.executionStarted && context.isPartial)
    container.addChild(new Text(toolRunningLine(theme), 0, 0));
  return container;
};

export const textResultBody = (
  theme: Theme,
  text: string,
  state: {
    readonly expanded: boolean;
    readonly isError: boolean;
    /** The call's arguments, which a failure's body then needn't repeat. */
    readonly args?: unknown;
  },
  collapsedLines: number,
): Component => {
  if (!text) return new Container();
  if (state.isError)
    return state.expanded ? errorSection(theme, text, state.args) : new Container();
  const lines = Str.split(text, "\n");
  if (state.expanded || lines.length <= collapsedLines + 1) {
    const body = new Text(theme.fg("toolOutput", text), 0, 0);
    // Expanded, the text indents beneath the heading like every expanded body.
    return state.expanded ? expandedSection(theme, undefined, body) : body;
  }
  return new Text(
    Arr.join(
      [
        theme.fg("toolOutput", Arr.join(lines.slice(0, collapsedLines), "\n")),
        renderExpansionAffordance(`${lines.length - collapsedLines} more lines`, false, theme),
      ],
      "\n",
    ),
    0,
    0,
  );
};
