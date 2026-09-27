import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import { clipToWidth } from "pi-cosmic-ui/manager";

/**
 * Expanded content nests under its heading: labels at two columns, bodies at four, or two
 * without a label. Indentation yields before content at narrow widths.
 */
export function expandedSection(
  theme: Theme,
  label: string | undefined,
  ...children: Component[]
): Component & { readonly content: Container } {
  const content = new Container();
  for (const child of children) content.addChild(child);
  return {
    content,
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
