import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import { framedFill, framedScreen, type ListDetailFrame } from "./list-detail-shell.ts";
import { clipToWidth } from "./chrome.ts";

export type TextPanelDismissMode = "any-key" | "back-keys";

export interface TextPanelOptions {
  readonly title: string;
  readonly theme?: Pick<Theme, "fg" | "bold">;
  readonly lines: ReadonlyArray<string>;
  readonly done: () => void;
  readonly frame: ListDetailFrame;
  readonly dismiss: TextPanelDismissMode;
  readonly footer?: string | undefined;
}

/** Bounded Pi-native read-only panel shared by diagnostics and informational submenus. */
export class TextPanelComponent implements Component {
  private readonly options: TextPanelOptions;

  constructor(options: TextPanelOptions) {
    this.options = options;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth === 0) return [];
    const footer =
      this.options.footer ??
      (this.options.dismiss === "any-key" ? " Press any key to close " : " Esc/q Back ");
    const inner = Math.max(0, safeWidth - 2);
    const body = this.options.lines.map((line) => clipToWidth(line, inner, "…"));
    return framedScreen(this.options.frame, {
      width: safeWidth,
      height: body.length + 2,
      top: ` ${this.options.theme?.bold(this.options.title) ?? this.options.title} `,
      bottom: clipToWidth(this.options.theme?.fg("dim", footer) ?? footer, inner, ""),
      body: (height) => framedFill(this.options.frame, body, height, inner),
    });
  }

  handleInput(data: string): void {
    if (
      this.options.dismiss === "any-key" ||
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      data.toLowerCase() === "q"
    )
      this.options.done();
  }

  invalidate(): void {
    // This panel has no cached rendering state.
  }
}
