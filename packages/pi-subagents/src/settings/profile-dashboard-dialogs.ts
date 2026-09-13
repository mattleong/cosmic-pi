import {
  Input,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { FullScreenKeymap, pageSteps } from "pi-cosmic-ui/manager/keymap";
import { isListMotion, nextListMotionIndex } from "pi-cosmic-ui/manager/list-navigation";
import { normalizeProfileSetName } from "../config/schema.ts";
import { isWorkspaceNavigationKey } from "./ui/profile-workspace-keys.ts";
import type { SearchableSelectHostOptions } from "pi-cosmic-ui/manager/searchable-select";

interface DialogOptions extends SearchableSelectHostOptions {
  readonly theme: Theme;
  readonly title: string;
  readonly body?: string;
  readonly initial?: string;
  readonly kind: "confirm" | "name";
  readonly close: (value: string | boolean | undefined) => void;
}

export class ProfileDashboardDialog implements Component, Focusable {
  private readonly input = new Input();
  private readonly keymap = new FullScreenKeymap();
  private disposed = false;
  private message = "";
  private offset = 0;
  private maxOffset = 0;
  private reviewed = false;
  private _focused = false;
  private readonly options: DialogOptions;
  constructor(options: DialogOptions) {
    this.options = {
      ...options,
      matchesKeybinding: (data, id) =>
        !isWorkspaceNavigationKey(data) && (options.matchesKeybinding?.(data, id) ?? false),
    };
    this.input.setValue(options.initial ?? "");
  }
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.options.kind === "name";
  }
  handleInput(data: string): void {
    if (this.disposed) return;
    const resolution = this.keymap.resolve(data, {
      mode: this.options.kind === "name" ? "text-input" : "confirmation",
      matchesKeybinding: this.options.matchesKeybinding,
    });
    if (resolution?._tag === "Action" && resolution.action === "cancel") {
      this.options.close(undefined);
      return;
    }
    if (resolution?._tag === "Action" && resolution.action === "confirm") {
      if (this.options.kind === "confirm") {
        if (this.reviewed) this.options.close(true);
        else this.message = "Scroll through the complete replacement before confirming.";
      } else {
        const name = normalizeProfileSetName(this.input.getValue());
        if (name) this.options.close(name);
        else this.message = "Use 1 to 64 characters, starting and ending with a letter or number.";
      }
    } else if (this.options.kind === "name") this.input.handleInput(data);
    else {
      const motion = this.keymap.resolve(data, {
        mode: "navigation",
        matchesKeybinding: this.options.matchesKeybinding,
      });
      if (motion?._tag === "Action" && isListMotion(motion.action))
        this.offset = nextListMotionIndex(
          motion.action,
          this.offset,
          this.maxOffset + 1,
          pageSteps(Math.max(1, this.options.getHeight() - 3)),
        );
    }
    this.options.requestRender();
  }
  render(width: number): string[] {
    if (this.disposed) return [];
    const label = this.options.keybindingLabel ?? ((_id, fallback) => fallback);
    const height = Math.max(0, this.options.getHeight());
    const bodyHeight = Math.max(0, height - 3);
    const body =
      this.options.kind === "name"
        ? this.input.render(Math.max(1, width))
        : wrapTextWithAnsi(this.options.body ?? "", Math.max(1, width));
    this.maxOffset = Math.max(0, body.length - bodyHeight);
    this.offset = Math.min(this.offset, this.maxOffset);
    if (bodyHeight > 0 && this.offset === this.maxOffset) this.reviewed = true;
    const hint = `${label("tui.select.confirm", "Enter")} Confirm · ${label("tui.select.cancel", "Esc")} Back${this.maxOffset ? " · ↑/↓ Scroll" : ""}`;
    return [
      this.options.theme.fg("accent", this.options.title),
      ...body.slice(this.offset, this.offset + bodyHeight),
      this.message,
      hint,
    ]
      .slice(0, height)
      .map((line) => truncateToWidth(line, Math.max(0, width)));
  }
  invalidate(): void {
    this.input.invalidate();
  }
  dispose(): void {
    this.disposed = true;
  }
}
