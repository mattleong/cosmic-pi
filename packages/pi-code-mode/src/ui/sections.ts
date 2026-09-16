/** Expanded sections reserve actual rows for spacing and yield indentation at narrow widths. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

export function addCodeModeSection(parent: Container, label: string, theme: Theme): Container {
  const content = new Container();
  parent.addChild(new Spacer(1));
  parent.addChild(new Text(theme.fg("muted", label), 2, 0));
  parent.addChild({
    render: (width) => {
      if (width <= 0) return [];
      const indent = Math.min(4, Math.max(0, width - 2));
      return content.render(width - indent).map((line) => `${" ".repeat(indent)}${line}`);
    },
    invalidate: () => content.invalidate(),
  });
  return content;
}
