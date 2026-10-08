import {
  Input,
  Key,
  matchesKey,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { FullScreenKeymap, pageSteps } from "pi-cosmic-ui/manager/keymap";
import { isListMotion, nextListMotionIndex } from "pi-cosmic-ui/manager/list-navigation";
import { normalizeProfileSetName } from "../config/schema.ts";
import type { ProfileSetSaveDestination } from "./profile-set-actions.ts";
import { withoutNavigationKeys } from "./ui/profile-workspace-keys.ts";
import type { SearchableSelectHostOptions } from "pi-cosmic-ui/manager/searchable-select";
import { clipToWidth } from "pi-cosmic-ui/manager";

type DialogOptions = SearchableSelectHostOptions & {
  readonly theme: Theme;
  readonly title: string;
  readonly body?: string;
  readonly initial?: string;
} & (
    | { readonly kind: "confirm"; readonly close: (confirmed: true | undefined) => void }
    | {
        readonly kind: "name";
        readonly destination?: undefined;
        readonly close: (name: string | undefined) => void;
      }
    | {
        readonly kind: "name";
        /** Raw ↑/↓ choose Project or Global; Project requires trust. */
        readonly destination: { readonly projectTrusted: boolean };
        readonly close: (value: ProfileSetSaveDestination | undefined) => void;
      }
  );

export class ProfileDashboardDialog implements Component, Focusable {
  private readonly input = new Input();
  private readonly keymap = new FullScreenKeymap();
  private disposed = false;
  private message = "";
  private offset = 0;
  private maxOffset = 0;
  private reviewed = false;
  private _focused = false;
  private scope: ProfileSetSaveDestination["scope"];
  private readonly options: DialogOptions;
  constructor(options: DialogOptions) {
    this.options = {
      ...options,
      matchesKeybinding: withoutNavigationKeys(options.matchesKeybinding),
    };
    this.scope =
      options.kind === "name" && options.destination?.projectTrusted ? "project" : "global";
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
    if (resolution?._tag === "Action" && resolution.action === "confirm") this.submit();
    else if (this.options.kind === "name") {
      if (!this.toggleDestination(data)) this.input.handleInput(data);
      this.message = "";
    } else {
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
  private submit(): void {
    if (this.options.kind === "confirm") {
      if (this.reviewed) this.options.close(true);
      else this.message = "Scroll through the complete details before confirming.";
      return;
    }
    const name = normalizeProfileSetName(this.input.getValue());
    if (!name)
      this.message = "Use 1 to 64 characters, starting and ending with a letter or number.";
    else if (this.options.destination) this.options.close({ scope: this.scope, name });
    else this.options.close(name);
  }
  /** Raw arrows only: configured printable bindings such as j/k stay in the Input. */
  private toggleDestination(data: string): boolean {
    const destination = this.options.kind === "name" && this.options.destination;
    if (!destination || !(matchesKey(data, Key.up) || matchesKey(data, Key.down))) return false;
    if (destination.projectTrusted) this.scope = this.scope === "project" ? "global" : "project";
    return true;
  }
  render(width: number): string[] {
    if (this.disposed) return [];
    const label = this.options.keybindingLabel ?? ((_id, fallback) => fallback);
    const height = Math.max(0, this.options.getHeight());
    const bodyHeight = Math.max(0, height - 3);
    const text = wrapTextWithAnsi(this.options.body ?? "", Math.max(1, width));
    const destination = this.options.kind === "name" && this.options.destination;
    const scopeRows = destination
      ? [
          `Destination: ${this.scope === "project" ? "Project · For this project" : "Global · For all projects"} ${this.options.theme.fg("dim", destination.projectTrusted ? "(↑/↓ change)" : "(Project requires trust)")}`,
        ]
      : [];
    // Name entry keeps the Input first so its cursor survives small heights, and never scrolls.
    const body =
      this.options.kind === "confirm"
        ? text
        : this.input.render(Math.max(1, width)).concat(scopeRows, this.options.body ? text : []);
    this.maxOffset = this.options.kind === "confirm" ? Math.max(0, body.length - bodyHeight) : 0;
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
      .map((line) => clipToWidth(line, Math.max(0, width)));
  }
  invalidate(): void {
    this.input.invalidate();
  }
  dispose(): void {
    this.disposed = true;
  }
}
