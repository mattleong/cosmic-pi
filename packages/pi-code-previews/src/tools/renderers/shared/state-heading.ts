import type { Component } from "@earendil-works/pi-tui";
import { previewHeadingText } from "../../../preview/heading-wrap";

/** A preview heading whose text follows the row's state, wrapped as every preview heading is. */
export function stateHeading(text: () => string): Component {
  return previewHeadingText(text);
}
