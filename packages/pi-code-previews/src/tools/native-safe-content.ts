import { Text, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import {
  decodeUnknownOrUndefined,
  invokeHostCallback,
  sanitizeDiagnosticError,
  stripTerminalControls,
} from "pi-cosmic-core";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { toolRunningLine } from "pi-cosmic-ui/tool";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getCodePreviewAnimationFrame } from "../preview/tool-timing";
import type { HostContainer } from "../shared/untrusted-value";
import { escapeControlChars } from "../shared/terminal-text";
import type { RendererState } from "./renderers/shared/types";

const ARRAY_SLOT = /^(?:length|\d+)$/u;

export function ownData<S extends Schema.ConstraintDecoder<unknown>>(
  value: HostContainer | undefined,
  key: string,
  schema: S,
): S["Type"] | undefined {
  const descriptor = invokeHostCallback(
    () =>
      value !== undefined && (Predicate.isObject(value) || ARRAY_SLOT.test(key))
        ? Object.getOwnPropertyDescriptor(value, key)
        : undefined,
    undefined,
  );
  return decodeUnknownOrUndefined(schema)(descriptor?.value);
}

export function visibleDiagnosticLine(text: string, maximumLength: number): string {
  return /[^\s\p{Cc}]/u.test(stripTerminalControls(text))
    ? sanitizeDiagnosticError(text, { maximumLength })
    : "";
}

export function plainRows(raw: string, maxRows: number): Component {
  const lines = escapeControlChars(raw).split("\n").slice(0, maxRows);
  return {
    render: (width) => lines.map((line) => clipToWidth(line, width)),
    invalidate() {},
  };
}

export function runningLine(theme: Theme, state: RendererState): Component {
  return {
    render: (width) =>
      new Text(toolRunningLine(theme, getCodePreviewAnimationFrame({ state })), 0, 0).render(width),
    invalidate() {},
  };
}

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
