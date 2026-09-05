import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";
import { FullScreenKeymap } from "pi-cosmic-ui/manager/keymap";
import type { SearchableSelectHostOptions } from "pi-cosmic-ui/manager/searchable-select";
import { normalizeProfileSetName } from "../config/schema.ts";
import { renderProfileSetSaveForm } from "./ui/profile-set-save-form-render.ts";

export interface ProfileSetSaveDestination {
  readonly scope: "global" | "project";
  readonly name: string;
}
export interface ProfileSetSaveFormOptions extends SearchableSelectHostOptions {
  readonly theme: Theme;
  readonly projectTrusted: boolean;
  readonly sectionKeyLabel?: string | undefined;
  readonly matchesSectionKey?: ((data: string) => boolean) | undefined;
  readonly initialScope?: "global" | "project" | undefined;
  readonly close: (result: ProfileSetSaveDestination | undefined) => void;
}

export class ProfileSetSaveFormComponent implements Component, Focusable {
  private readonly input = new Input();
  private readonly keymap = new FullScreenKeymap();
  private readonly options: ProfileSetSaveFormOptions;
  private scope: "global" | "project";
  private section: "destination" | "name" | "save" = "name";
  private message: string | undefined;
  private disposed = false;
  private _focused = false;
  constructor(options: ProfileSetSaveFormOptions) {
    this.options = options;
    this.scope = options.projectTrusted ? (options.initialScope ?? "project") : "global";
  }
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.section === "name";
  }
  private submit(): void {
    const name = normalizeProfileSetName(this.input.getValue());
    if (!name) {
      this.message = "Use 1 to 64 characters; start and end with a letter or number.";
      return;
    }
    this.options.close({ scope: this.scope, name });
  }
  private moveDestination(action: string): void {
    if (
      this.section === "destination" &&
      this.options.projectTrusted &&
      ["up", "down", "back", "forward"].includes(action)
    )
      this.scope = this.scope === "project" ? "global" : "project";
  }
  handleInput(data: string): void {
    if (this.disposed) return;
    const resolution = this.keymap.resolve(data, {
      mode: this.section === "name" ? "text-input" : "navigation",
      matchesKeybinding: this.options.matchesKeybinding,
    });
    if (resolution?._tag === "Action" && resolution.action === "cancel") {
      this.options.close(undefined);
      return;
    }
    const nextSection = matchesKey(data, Key.tab) || this.options.matchesSectionKey?.(data);
    if (nextSection || matchesKey(data, Key.shift("tab"))) {
      const sections = ["destination", "name", "save"] as const;
      this.section = sections[(sections.indexOf(this.section) + (nextSection ? 1 : 2)) % 3]!;
      this.focused = this._focused;
    } else if (resolution?._tag === "Action" && resolution.action === "confirm") {
      if (this.section === "destination") {
        this.section = "name";
        this.focused = this._focused;
      } else this.submit();
    } else if (this.section === "name") {
      this.input.handleInput(data);
      this.message = undefined;
    } else if (resolution?._tag === "Action") this.moveDestination(resolution.action);
    this.options.requestRender();
  }
  render(width: number): string[] {
    if (this.disposed) return [];
    return renderProfileSetSaveForm(
      {
        scope: this.scope,
        section: this.section,
        nameRows: this.input.render(Math.max(1, width - 6)),
        message: this.message,
        projectTrusted: this.options.projectTrusted,
      },
      { ...this.options, width, height: this.options.getHeight() },
    );
  }
  invalidate(): void {
    this.input.invalidate();
  }
  dispose(): void {
    this.disposed = true;
  }
}
