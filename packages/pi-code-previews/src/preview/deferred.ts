import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import {
  captureCodePreviewSessionCapability,
  type CodePreviewSessionCapability,
} from "../application/capability";
import { codePreviewPerformanceConfig } from "../config/state";
import { escapeControlChars } from "../shared/terminal-text";

export function shouldRenderDeferred(characters: number): boolean {
  return characters > codePreviewPerformanceConfig.asyncRenderChars;
}

export class DeferredPreview implements Component {
  private component: Component;
  private cancelled = false;
  private cancellation: (() => void) | undefined;
  private compute: ((active: boolean) => Component) | undefined;
  private readonly owner: CodePreviewSessionCapability | undefined;

  constructor(
    message: string,
    theme: Theme,
    compute: (active: boolean) => Component,
    invalidate: () => void,
    owner = captureCodePreviewSessionCapability(),
  ) {
    this.owner = owner;
    this.component = new Text(theme.fg("muted", message), 0, 0);
    this.compute = (active) => {
      try {
        return compute(active);
      } catch (error) {
        return new Text(
          theme.fg(
            "error",
            escapeControlChars(error instanceof Error ? error.message : String(error)),
          ),
          0,
          0,
        );
      }
    };
    this.cancellation = this.owner?.defer(() => {
      if (this.cancelled || captureCodePreviewSessionCapability() !== this.owner) return;
      this.complete(true);
      this.cancellation = undefined;
      if (!this.cancelled && captureCodePreviewSessionCapability() === this.owner) invalidate();
    });
  }

  private complete(active: boolean): void {
    const compute = this.compute;
    this.compute = undefined;
    if (!compute) return;
    const component = compute(active);
    if (!this.cancelled) this.component = component;
  }

  cancel(): void {
    this.cancelled = true;
    this.compute = undefined;
    this.cancellation?.();
    this.cancellation = undefined;
  }

  render(width: number): string[] {
    if (
      !this.cancelled &&
      this.compute &&
      (!this.owner || captureCodePreviewSessionCapability() !== this.owner)
    ) {
      this.cancellation?.();
      this.cancellation = undefined;
      this.complete(false);
    }
    return this.component.render(width);
  }

  invalidate(): void {
    this.component.invalidate();
  }
}
