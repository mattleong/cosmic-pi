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
  return {
    render(width) {
      if (width <= 0) return [];
      const heading = label ? [clipToWidth(`  ${theme.fg("muted", label)}`, width, "")] : [];
      const indent = Math.min(label ? 4 : 2, Math.max(0, width - 2));
      const pad = Fn.pipe(" ", Str.repeat(indent));
      return heading.concat(Arr.map(content.render(width - indent), (line) => `${pad}${line}`));
    },
    invalidate: () => content.invalidate(),
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
