import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { expandedSection, isRejectedEmptyCall } from "pi-code-previews";
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

export const errorSection = (theme: Theme, text: string): Component =>
  expandedSection(theme, "Error", new Text(theme.fg("toolOutput", text), 0, 0));

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
  state: { readonly expanded: boolean; readonly isError: boolean },
  collapsedLines: number,
): Component => {
  if (!text) return new Container();
  if (state.isError) return state.expanded ? errorSection(theme, text) : new Container();
  const lines = text.split("\n");
  if (state.expanded || lines.length <= collapsedLines + 1)
    return new Text(theme.fg("toolOutput", text), 0, 0);
  return new Text(
    [
      theme.fg("toolOutput", lines.slice(0, collapsedLines).join("\n")),
      renderExpansionAffordance(`${lines.length - collapsedLines} more lines`, false, theme),
    ].join("\n"),
    0,
    0,
  );
};
