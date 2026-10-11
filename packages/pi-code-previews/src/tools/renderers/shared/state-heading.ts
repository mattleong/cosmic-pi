import { Text, type Component } from "@earendil-works/pi-tui";

/**
 * A call heading that rereads result state when drawn, since Pi renders the result after the
 * call. `text` must close over renderer state, never the render context: the context's
 * lastComponent would keep every earlier call component alive.
 */
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
