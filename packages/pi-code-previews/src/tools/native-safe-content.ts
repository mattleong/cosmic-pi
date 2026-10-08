import { Text, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import {
  decodeUnknownOrUndefined,
  invokeHostCallback,
  sanitizeDiagnosticError,
  stripAnsi,
} from "pi-cosmic-core";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { toolRunningLine } from "pi-cosmic-ui/tool";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getCodePreviewAnimationFrame } from "../preview/tool-timing";
import { escapeControlChars } from "../shared/terminal-text";
import type { ToolRenderContext } from "./renderers/shared/types";

/** Arrays are evidence only through their length and index slots, never named properties. */
const ARRAY_SLOT = /^(?:length|\d+)$/u;

/**
 * One own data property of untrusted native evidence, decoded by `schema`. Getters are never
 * invoked: missing keys, accessors and throwing proxies all decode as undefined.
 */
export function ownData<S extends Schema.ConstraintDecoder<unknown>, Value>(
  value: Value,
  key: string,
  schema: S,
): S["Type"] | undefined {
  const descriptor = invokeHostCallback(
    () =>
      Predicate.isObject(value) || (Array.isArray(value) && ARRAY_SLOT.test(key))
        ? Object.getOwnPropertyDescriptor(value, key)
        : undefined,
    undefined,
  );
  return decodeUnknownOrUndefined(schema, descriptor?.value);
}

/**
 * A redacted single line clipped to `maximumLength`. Text with nothing visible stays empty
 * instead of becoming the sanitizer's "Unknown error." placeholder.
 */
export function visibleDiagnosticLine(text: string, maximumLength: number): string {
  return /[^\s\p{Cc}]/u.test(stripAnsi(text))
    ? sanitizeDiagnosticError(text, { maximumLength })
    : "";
}

/** Plain text in at most `maxRows` clipped rows, for a bounded collapsed fallback. */
export function plainRows(raw: string, maxRows: number): Component {
  const lines = escapeControlChars(raw).split("\n").slice(0, maxRows);
  return {
    render: (width) => lines.map((line) => clipToWidth(line, width)),
    invalidate() {},
  };
}

/** The shared running line, animated by the registering owner's scheduler. */
export function runningLine(theme: Theme, context: ToolRenderContext<any, any>): Component {
  return {
    render: (width) =>
      new Text(toolRunningLine(theme, getCodePreviewAnimationFrame(context)), 0, 0).render(width),
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
