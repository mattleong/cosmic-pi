import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import { Input, Key, matchesKey, wrapTextWithAnsi, type Focusable } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { FullScreenKeymap } from "pi-cosmic-ui/manager/keymap";
import { selectionMarker } from "pi-cosmic-ui/manager/style";
import { normalizeProfileSetName } from "../config/schema.ts";
import type { ProfileSetSaveDestination } from "./profile-set-actions.ts";
import { withoutNavigationKeys } from "./ui/profile-workspace-keys.ts";
import type { SearchableSelectHostOptions } from "pi-cosmic-ui/manager/searchable-select";
import {
  configuredKeyLabels,
  exitKeyHint,
  joinKeyHints,
  keyHint,
  TEXT_INPUT_KEY_LABELS,
} from "pi-cosmic-ui/manager/key-labels";
import type { DashboardPrompt } from "./ui/profile-dashboard-render.ts";

type DialogOptions = Pick<
  SearchableSelectHostOptions,
  "requestRender" | "matchesKeybinding" | "keybindingLabel"
> & {
  readonly theme: Theme;
  readonly title: string;
  readonly body?: string;
  readonly initial?: string;
  /** What Enter does, such as `Delete` or `Save`; the border names it. */
  readonly verb: string;
} & (
    | { readonly kind: "confirm"; readonly close: (confirmed: true | undefined) => void }
    | {
        readonly kind: "name";
        readonly destination?: undefined;
        readonly close: (name: string | undefined) => void;
      }
    | {
        readonly kind: "name";
        readonly destination: { readonly projectTrusted: boolean };
        readonly close: (value: ProfileSetSaveDestination | undefined) => void;
      }
  );

/**
 * A decision the dashboard keeps beside the pane it concerns: a confirmation, or a name with an
 * optional destination. `prompt` draws it for the pane's prompt band, and the pane stays in view.
 */
export class ProfileDashboardDialog implements Focusable {
  private readonly input = new Input();
  private readonly keymap = new FullScreenKeymap();
  private disposed = false;
  private message = "";
  private focusState = false;
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
    return this.focusState;
  }
  set focused(value: boolean) {
    this.focusState = value;
    this.input.focused = value && this.options.kind === "name";
  }
  handleInput(data: string): void {
    if (this.disposed) return;
    const resolution = this.keymap.resolve(data, {
      mode: this.options.kind === "name" ? "text-input" : "confirmation",
      matchesKeybinding: this.options.matchesKeybinding,
    });
    const action = Predicate.isTagged(resolution, "Action") ? resolution.action : undefined;
    if (action === "cancel") {
      this.options.close(undefined);
      return;
    }
    if (action === "confirm") this.submit();
    else if (this.options.kind === "name") {
      if (!this.toggleDestination(data)) this.input.handleInput(data);
      this.message = "";
    }
    this.options.requestRender();
  }
  private submit(): void {
    if (this.options.kind === "confirm") {
      this.options.close(true);
      return;
    }
    const name = normalizeProfileSetName(this.input.getValue());
    if (!name)
      this.message = "Use 1 to 64 characters, starting and ending with a letter or number.";
    else if (this.options.destination) this.options.close({ scope: this.scope, name });
    else this.options.close(name);
  }
  private toggleDestination(data: string): boolean {
    const destination = this.options.kind === "name" && this.options.destination;
    if (!destination || !(matchesKey(data, Key.up) || matchesKey(data, Key.down))) return false;
    if (destination.projectTrusted) this.scope = this.scope === "project" ? "global" : "project";
    return true;
  }
  /** Both destinations as single-select rows, so `↑↓ Destination` has something to move. */
  private destinationRows(projectTrusted: boolean): ReadonlyArray<string> {
    const { theme } = this.options;
    const row = (scope: ProfileSetSaveDestination["scope"], label: string) =>
      `${selectionMarker("single", this.scope === scope)} ${label}`;
    return [
      projectTrusted
        ? row("project", "Project · for this project")
        : theme.fg("dim", row("project", "Project · trust this project to save here")),
      row("global", "Global · for all projects"),
    ];
  }
  /** The dialog's band text for a pane `width` columns wide, and the keys for the border. */
  prompt(width: number): DashboardPrompt {
    if (this.disposed) return { text: "", hint: "" };
    const { theme, kind } = this.options;
    // A name dialog types into its input, so a configured key that types text never labels a hint.
    const keys = configuredKeyLabels(this.options.keybindingLabel, TEXT_INPUT_KEY_LABELS);
    const destination = kind === "name" ? this.options.destination : undefined;
    const title = theme.fg(
      kind === "confirm" ? "warning" : "accent",
      theme.bold(this.options.title),
    );
    const body = this.options.body
      ? [theme.fg(kind === "confirm" ? "warning" : "muted", this.options.body)]
      : [];
    const wrap = (lines: ReadonlyArray<string>) =>
      Arr.flatMap(lines, (line) => wrapTextWithAnsi(line, Math.max(1, width)));
    // The input keeps its one row whole; everything else wraps to the band.
    const lines = [
      ...wrap([title]),
      ...(kind === "name" ? this.input.render(Math.max(1, width)) : []),
      ...wrap([
        ...(destination ? this.destinationRows(destination.projectTrusted) : []),
        ...body,
        ...(this.message ? [theme.fg("error", this.message)] : []),
      ]),
    ];
    return {
      text: lines,
      hint: joinKeyHints([
        destination?.projectTrusted === true && keyHint("↑↓", "Destination"),
        keyHint(keys.primary("tui.select.confirm", "Enter"), this.options.verb),
        exitKeyHint("decision", [], keys.primary("tui.select.cancel", "Esc")),
      ]),
    };
  }
  invalidate(): void {
    this.input.invalidate();
  }
  dispose(): void {
    this.disposed = true;
  }
}
