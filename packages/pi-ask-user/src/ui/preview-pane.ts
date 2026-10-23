import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { stripTerminalControls } from "pi-cosmic-core/security";
import type { AskUserChoice } from "../questionnaire/schema.ts";
import { padListDetailRow } from "pi-cosmic-ui/manager/list-detail";

export class PreviewPane {
  private choice: AskUserChoice | undefined;
  private markdown: Markdown | undefined;
  private framed: { readonly width: number; readonly lines: string[] } | undefined;
  private readonly theme: Theme;

  constructor(theme: Theme) {
    this.theme = theme;
  }

  setChoice(choice: AskUserChoice | undefined): void {
    if (choice === this.choice) return;
    this.choice = choice;
    this.framed = undefined;
    this.markdown = choice?.preview
      ? new Markdown(stripTerminalControls(choice.preview), 0, 0, getMarkdownTheme())
      : undefined;
  }

  // Every framed row is exactly `max(8, width)` columns wide, so callers can place rows unpadded.
  render(width: number): string[] {
    if (this.framed?.width === width) return this.framed.lines;
    const lines = this.frame(width);
    this.framed = { width, lines };
    return lines;
  }

  private frame(width: number): string[] {
    const boxWidth = Math.max(8, width);
    const innerWidth = Math.max(1, boxWidth - 4);
    const border = (value: string) => this.theme.fg("borderMuted", value);
    const lines = [border(`┌${Fn.pipe("─", Str.repeat(Math.max(0, boxWidth - 2)))}┐`)];
    const title = this.choice
      ? `${this.theme.fg("accent", this.theme.bold("Preview"))} ${this.theme.fg("muted", stripTerminalControls(this.choice.label))}`
      : this.theme.fg("muted", "No preview for this choice");
    lines.push(`${border("│")} ${padListDetailRow(title, innerWidth)} ${border("│")}`);
    lines.push(`${border("│")} ${Fn.pipe(" ", Str.repeat(innerWidth))} ${border("│")}`);

    const rendered = this.markdown?.render(innerWidth) ?? [
      this.theme.fg("dim", "Focus a choice with a preview to compare it here."),
    ];
    for (const line of rendered) {
      lines.push(`${border("│")} ${padListDetailRow(line, innerWidth)} ${border("│")}`);
    }
    lines.push(border(`└${Fn.pipe("─", Str.repeat(Math.max(0, boxWidth - 2)))}┘`));
    return lines;
  }

  invalidate(): void {
    this.framed = undefined;
    this.markdown?.invalidate();
  }
}
