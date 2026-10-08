import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { deferCodePreview } from "../application/capability";
import { codePreviewPerformanceConfig } from "../config/state";
import { escapeControlChars } from "../shared/terminal-text";

export function shouldRenderDeferred(text: string): boolean {
  return text.length > codePreviewPerformanceConfig.asyncRenderChars;
}

/**
 * Deferred same-thread publication. This deliberately does not claim CPU offload: the pure render
 * still runs on the session fiber after a yield and remains synchronously compatible with Pi/TUI.
 */
export class DeferredPreview implements Component {
  private component: Component;
  private cancelled = false;
  private cancellation: (() => void) | undefined;

  constructor(message: string, theme: Theme, compute: () => Component, invalidate: () => void) {
    this.component = new Text(theme.fg("muted", message), 0, 0);
    this.cancellation = deferCodePreview(() => {
      if (this.cancelled) return;
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
      if (this.cancelled) return;
      this.component = next;
      this.cancellation = undefined;
      invalidate();
    });
  }

  cancel(): void {
    this.cancelled = true;
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
