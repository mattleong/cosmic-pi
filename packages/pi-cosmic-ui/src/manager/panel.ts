import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import {
  framedFill,
  framedScreen,
  listDetailFrame,
  type ListDetailFrame,
} from "./list-detail-shell.ts";
import { clipToWidth } from "./chrome.ts";

export type TextPanelDismissMode = "any-key" | "back-keys";

interface TextPanelOptions {
  readonly title: string;
  readonly theme: Pick<Theme, "fg" | "bold">;
  readonly lines: ReadonlyArray<string>;
  readonly done: () => void;
  readonly dismiss: TextPanelDismissMode;
}

export class TextPanelComponent implements Component {
  private readonly options: TextPanelOptions;
  private readonly frame: ListDetailFrame;

  constructor(options: TextPanelOptions) {
    this.options = options;
    this.frame = listDetailFrame(options.theme);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth === 0) return [];
    const { theme, title } = this.options;
    const footer = this.options.dismiss === "any-key" ? " Press any key to close " : " Esc/q Back ";
    const inner = Math.max(0, safeWidth - 2);
    const body = Arr.map(this.options.lines, (line) => clipToWidth(line, inner, "…"));
    return framedScreen(this.frame, {
      width: safeWidth,
      height: body.length + 2,
      top: ` ${theme.bold(title)} `,
      bottom: clipToWidth(theme.fg("dim", footer), inner, ""),
      body: (height) => framedFill(this.frame, body, height, inner),
    });
  }

  handleInput(data: string): void {
    if (
      this.options.dismiss === "any-key" ||
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      Str.toLowerCase(data) === "q"
    )
      this.options.done();
  }

  invalidate(): void {}
}
