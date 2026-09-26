import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { escapeControlChars } from "../../../shared/terminal-text";
import { toolStatusLine } from "pi-cosmic-ui/tool";

export function renderResultPrelude(options: {
  isPartial: boolean;
  theme: Theme;
  loadingLabel: string;
  isError?: boolean;
  errorText?: string;
}): Component | undefined {
  if (options.isPartial)
    return new Text(toolStatusLine(options.theme, "running", options.loadingLabel), 0, 0);
  if (options.isError && options.errorText !== undefined)
    return new Text(
      toolStatusLine(options.theme, "error", escapeControlChars(options.errorText)),
      0,
      0,
    );
  return undefined;
}
