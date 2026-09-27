/**
 * Preview-style bodies for a child's parent-contact tools: `contact_parent` and the four
 * supervisor tools. The shared shell draws their warning and failure lines; these bodies show
 * the request, the parent's reply, and acknowledgements.
 */
import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { expandedSection, getTextContent } from "pi-code-previews";
import { sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core";
import { renderExpansionAffordance, renderToolHeader, toolRunningLine } from "pi-cosmic-ui/tool";
import { parentRequest } from "./compact-parent-summary.ts";

/** Input the heading's bounded subtitle shows exactly. */
const fitsHeading = (message: string): boolean =>
  message.length <= 120 && sanitizeTerminalLine(message) === message;

/** Lines of a reply or receipt a collapsed row shows before its expansion affordance. */
const COLLAPSED_REPLY_LINES = 4;

/** The parts of Pi's render context these bodies read. */
interface ParentRenderContext {
  readonly expanded: boolean;
  readonly executionStarted: boolean;
  readonly isPartial: boolean;
  readonly isError: boolean;
}

export interface ParentToolRenderers {
  renderCall<Args>(args: Args, theme: Theme, context: ParentRenderContext): Component;
  renderResult<Details>(
    result: AgentToolResult<Details>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: ParentRenderContext,
  ): Component;
}

const boundedText = (text: string, expanded: boolean, theme: Theme): Component => {
  const lines = text.split("\n");
  if (expanded || lines.length <= COLLAPSED_REPLY_LINES + 1)
    return new Text(theme.fg("toolOutput", text), 0, 0);
  return new Text(
    [
      theme.fg("toolOutput", lines.slice(0, COLLAPSED_REPLY_LINES).join("\n")),
      renderExpansionAffordance(`${lines.length - COLLAPSED_REPLY_LINES} more lines`, false, theme),
    ].join("\n"),
    0,
    0,
  );
};

/** Call and result bodies for one parent-contact tool, named as its definition labels it. */
export function parentToolRenderers(toolName: string, label: string): ParentToolRenderers {
  return {
    renderCall(args, theme, context) {
      const request = parentRequest(toolName, args);
      const kind = toolName === "contact_parent" ? request?.action : undefined;
      // A warning's text is the shell's issue line, so the heading names only the kind.
      const message = request && request.action !== "warning" ? request.message : undefined;
      const subject = [kind, message].filter(Boolean).join(": ");
      const container = new Container();
      container.addChild(
        new Text(renderToolHeader({ title: label, subtitle: subject }, theme), 0, 0),
      );
      // The heading shows one bounded line; longer or multi-line input appears whole.
      if (context.expanded && message && !fitsHeading(message))
        container.addChild(new Text(theme.fg("toolOutput", stripTerminalControls(message)), 0, 0));
      if (context.executionStarted && context.isPartial)
        container.addChild(new Text(toolRunningLine(theme), 0, 0));
      return container;
    },
    renderResult(result, options, theme, context) {
      const text = stripTerminalControls(getTextContent(result.content));
      if (!text) return new Container();
      if (context.isError)
        return options.expanded
          ? expandedSection(theme, "Error", new Text(theme.fg("toolOutput", text), 0, 0))
          : new Container();
      return boundedText(text, options.expanded, theme);
    },
  };
}
