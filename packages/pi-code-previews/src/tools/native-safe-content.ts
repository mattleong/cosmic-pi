import { Text, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { escapeControlChars } from "../shared/terminal-text";

/** Plain text in at most `maxRows` clipped rows, for a bounded collapsed fallback. */
export function plainRows(raw: string, maxRows: number): Component {
  const lines = escapeControlChars(raw).split("\n").slice(0, maxRows);
  return {
    render: (width) => lines.map((line) => clipToWidth(line, width)),
    invalidate() {},
  };
}

/**
 * Native source and output survive a host theme or highlighter that fails while building or
 * drawing them. A string fallback is drawn as plain text; after a failure the fallback stays.
 */
export function safeContent(build: () => Component, fallback: string | Component): Component {
  const plain = Predicate.isString(fallback)
    ? new Text(escapeControlChars(fallback), 0, 0)
    : fallback;
  let body: Component;
  try {
    body = build();
  } catch {
    return plain;
  }
  let failed = false;
  return {
    render(width) {
      if (!failed) {
        try {
          return body.render(width);
        } catch {
          failed = true;
        }
      }
      return plain.render(width);
    },
    invalidate() {
      if (!failed) {
        try {
          body.invalidate();
        } catch {
          failed = true;
        }
      }
      plain.invalidate();
    },
  };
}
