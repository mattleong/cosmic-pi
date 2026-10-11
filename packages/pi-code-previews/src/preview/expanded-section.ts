import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { fallbackArguments } from "../tools/data/args";
import type { RendererArguments } from "../tools/renderers/shared/types";

/**
 * Expanded content nests under its heading: labels at two columns, bodies at four, or two
 * without a label. Indentation yields before content at narrow widths.
 */
export function expandedSection(
  theme: Theme,
  label: string | undefined,
  ...children: Component[]
): Component {
  const content = new Container();
  for (const child of children) content.addChild(child);
  return {
    render(width) {
      if (width <= 0) return [];
      const heading = label ? [clipToWidth(`  ${theme.fg("muted", label)}`, width, "")] : [];
      const indent = Math.min(label ? 4 : 2, Math.max(0, width - 2));
      const pad = " ".repeat(indent);
      return heading.concat(content.render(width - indent).map((line) => `${pad}${line}`));
    },
    invalidate: () => content.invalidate(),
  };
}

/**
 * A call's exact input in full. Controls show as symbols rather than being removed, so nothing
 * the tool receives can hide from this view; empty or unserializable arguments add nothing.
 */
export function expandedArguments(theme: Theme, args: RendererArguments): Component {
  const lines = fallbackArguments(args);
  if (lines.length === 0) return new Container();
  const text = lines.map((line) => theme.fg("toolOutput", line)).join("\n");
  return expandedSection(theme, "Arguments", new Text(text, 0, 0));
}
