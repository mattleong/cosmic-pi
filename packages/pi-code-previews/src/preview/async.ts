import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { codePreviewPerformanceConfig } from "../config/env";
import { deferCodePreview } from "../session-capability";
import { escapeControlChars } from "../shared/terminal-text";

export function shouldRenderAsync(text: string): boolean {
  return text.length > codePreviewPerformanceConfig.asyncRenderChars;
}

export class AsyncPreview implements Component {
  private component: Component;
  private generation = 0;
  private cancellation: (() => void) | undefined;

  constructor(message: string, theme: Theme, compute: () => Component, invalidate: () => void) {
    this.component = new Text(theme.fg("muted", message), 0, 0);
    const generation = ++this.generation;
    this.cancellation = deferCodePreview(() => {
      if (generation !== this.generation) return;
      let next: Component;
      try {
        next = compute();
      } catch (error) {
        next = new Text(
          theme.fg(
            "error",
            escapeControlChars(error instanceof Error ? error.message : String(error)),
          ),
          0,
          0,
        );
      }
      if (generation !== this.generation) return;
      this.component = next;
      this.cancellation = undefined;
      invalidate();
    });
  }

  cancel(): void {
    this.generation++;
    this.cancellation?.();
    this.cancellation = undefined;
  }

  render(width: number): string[] {
    return this.component.render(width);
  }

  invalidate(): void {
    this.component.invalidate();
  }
}
