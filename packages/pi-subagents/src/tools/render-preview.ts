/**
 * Preview-style pieces the tool bodies share: a call's heading with its running line, and a text
 * result's bounded preview. A rejected call's text is already the shell's issue line, so it
 * appears only once expanded, under its own label.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { expandedSection } from "pi-code-previews";
import {
  renderExpansionAffordance,
  renderToolHeader,
  toolRunningLine,
  type ToolHeader,
} from "pi-cosmic-ui/tool";

/** The parts of Pi's render context these bodies read. */
export interface PreviewRenderContext {
  readonly expanded: boolean;
  readonly executionStarted: boolean;
  readonly isPartial: boolean;
  readonly isError: boolean;
}

/** A rejection's own text, labelled, for expanded views. */
export const errorSection = (theme: Theme, text: string): Component =>
  expandedSection(theme, "Error", new Text(theme.fg("toolOutput", text), 0, 0));

/** The call's heading, then its unique content, then a running line while it runs. */
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

/** Text shown whole once expanded, otherwise its first `collapsedLines` lines and an affordance. */
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
