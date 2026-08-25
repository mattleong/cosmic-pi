import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { stripTerminalControls } from "pi-cosmic-core";
import type { AskUserChoice } from "../questionnaire/schema.ts";
import { padLine } from "./layout.ts";

const MAX_PREVIEW_LINES = 20;

export class PreviewPane {
  private choice: AskUserChoice | undefined;
  private markdown: Markdown | undefined;
  private readonly theme: Theme;

  constructor(theme: Theme) {
    this.theme = theme;
  }

  setChoice(choice: AskUserChoice | undefined): void {
    if (choice === this.choice) return;
    this.choice = choice;
    this.markdown = choice?.preview
      ? new Markdown(stripTerminalControls(choice.preview), 0, 0, getMarkdownTheme())
      : undefined;
  }

  render(width: number): string[] {
    const boxWidth = Math.max(8, width);
    const innerWidth = Math.max(1, boxWidth - 4);
    const border = (value: string) => this.theme.fg("borderMuted", value);
    const lines = [border(`┌${"─".repeat(Math.max(0, boxWidth - 2))}┐`)];
    const title = this.choice
      ? `${this.theme.fg("accent", this.theme.bold("Preview"))} ${this.theme.fg("muted", stripTerminalControls(this.choice.label))}`
      : this.theme.fg("muted", "No preview for this choice");
    lines.push(`${border("│")} ${padLine(title, innerWidth)} ${border("│")}`);
    lines.push(`${border("│")} ${" ".repeat(innerWidth)} ${border("│")}`);

    const rendered = this.markdown?.render(innerWidth) ?? [
      this.theme.fg("dim", "Focus a choice with a preview to compare it here."),
    ];
    const visible = rendered.slice(0, MAX_PREVIEW_LINES);
    if (rendered.length > MAX_PREVIEW_LINES) {
      visible[MAX_PREVIEW_LINES - 1] = this.theme.fg(
        "dim",
        `… ${rendered.length - MAX_PREVIEW_LINES + 1} more lines`,
      );
    }
    for (const line of visible) {
      lines.push(`${border("│")} ${padLine(line, innerWidth)} ${border("│")}`);
    }
    lines.push(border(`└${"─".repeat(Math.max(0, boxWidth - 2))}┘`));
    return lines;
  }

  invalidate(): void {
    this.markdown?.invalidate();
  }
}
