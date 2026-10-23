import { Text, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Arr from "effect/Array";
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
import { HostContainerSchema, type HostContainer } from "../shared/untrusted-value";
import { escapeControlChars } from "../shared/terminal-text";
import { splitLinesLimited } from "../shared/text-lines";
import type { RendererState } from "./renderers/shared/types";

const ARRAY_SLOT = /^(?:length|\d+)$/u;

/** Reads own data properties without invoking accessors; build each reader once per schema. */
export function ownDataReader<S extends Schema.ConstraintDecoder<unknown>>(schema: S) {
  const decode = decodeUnknownOrUndefined(schema);
  return (value: HostContainer | undefined, key: string): S["Type"] | undefined => {
    const descriptor = invokeHostCallback(
      () =>
        value !== undefined && (Predicate.isObject(value) || ARRAY_SLOT.test(key))
          ? Object.getOwnPropertyDescriptor(value, key)
          : undefined,
      undefined,
    );
    return decode(descriptor?.value);
  };
}

export const ownString = ownDataReader(Schema.String);
export const ownContainer = ownDataReader(HostContainerSchema);

export function visibleDiagnosticLine(text: string, maximumLength: number): string {
  return /[^\s\p{Cc}]/u.test(stripTerminalControls(text))
    ? sanitizeDiagnosticError(text, { maximumLength })
    : "";
}

export function plainRows(raw: string, maxRows: number): Component {
  let lines: readonly string[] | undefined;
  return {
    render(width) {
      lines ??= Arr.map(splitLinesLimited(raw, maxRows), (line) => escapeControlChars(line));
      return Arr.map(lines, (line) => clipToWidth(line, width));
    },
    invalidate() {},
  };
}

/** Escaped plain text, built only when a fallback is actually drawn. */
export function plainText(text: string | (() => string)): Component {
  let rendered: Text | undefined;
  return {
    render(width) {
      rendered ??= new Text(escapeControlChars(Predicate.isString(text) ? text : text()), 0, 0);
      return rendered.render(width);
    },
    invalidate() {
      rendered?.invalidate();
    },
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
  const plain = Predicate.isString(fallback) ? plainText(fallback) : fallback;
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
