import { Text, type Component } from "@earendil-works/pi-tui";

export function stateHeading(text: () => string): Component {
  const heading = new Text("", 0, 0);
  let shown: string | undefined;
  return {
    render(width) {
      const next = text();
      if (next !== shown) heading.setText((shown = next));
      return heading.render(width);
    },
    invalidate() {
      heading.invalidate();
    },
  };
}
