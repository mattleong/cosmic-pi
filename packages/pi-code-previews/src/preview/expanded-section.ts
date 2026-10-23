import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { fallbackArguments } from "../tools/data/args";
import { type HostValue } from "../shared/untrusted-value";

export function expandedSection(
  theme: Theme,
  label: string | undefined,
  ...children: Component[]
): Component {
  const content = new Container();
  for (const child of children) content.addChild(child);
  // Children that cache their rows return the same arrays, so unchanged content is not re-indented.
  let cached:
    | { readonly width: number; readonly parts: readonly string[][]; readonly rows: string[] }
    | undefined;
  return {
    render(width) {
      if (width <= 0) return [];
      const indent = Math.min(label ? 4 : 2, Math.max(0, width - 2));
      const parts = Arr.map(content.children, (child) => child.render(width - indent));
      if (
        cached?.width === width &&
        Arr.every(parts, (part, index) => part === cached?.parts[index])
      )
        return cached.rows;
      const heading = label ? [clipToWidth(`  ${theme.fg("muted", label)}`, width, "")] : [];
      const pad = Fn.pipe(" ", Str.repeat(indent));
      const rows = heading.concat(
        Arr.flatMap(parts, (lines) => Arr.map(lines, (line) => `${pad}${line}`)),
      );
      cached = { width, parts, rows };
      return rows;
    },
    invalidate() {
      cached = undefined;
      content.invalidate();
    },
  };
}

export function expandedArguments(theme: Theme, args: HostValue | undefined): Component {
  const lines = fallbackArguments(args);
  if (lines.length === 0) return new Container();
  const text = Arr.join(
    Arr.map(lines, (line) => theme.fg("toolOutput", line)),
    "\n",
  );
  return expandedSection(theme, "Arguments", new Text(text, 0, 0));
}
