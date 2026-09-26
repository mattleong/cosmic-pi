import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { escapeControlChars } from "../../../shared/terminal-text";
import { toolStatusLine } from "pi-cosmic-ui/tool";

export function renderResultPrelude(options: {
  isPartial: boolean;
  theme: Theme;
  loadingLabel: string;
  isError?: boolean;
  expanded?: boolean;
  errorText?: string;
}): Component | undefined {
  if (options.isPartial)
    return new Text(toolStatusLine(options.theme, "running", options.loadingLabel), 0, 0);
  // The issue line above the body already summarises the error; expansion shows it all.
  if (options.isError)
    return renderPreviewError(options.theme, options.expanded, options.errorText);
  return undefined;
}

export function renderPreviewError(
  theme: Theme,
  expanded: boolean | undefined,
  errorText: string | undefined,
): Component {
  return expanded && errorText
    ? new Text(theme.fg("error", escapeControlChars(errorText)), 0, 0)
    : new Container();
}
