import {
  KeybindingsManager as TuiKeybindingsManager,
  setKeybindings,
  Text,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { plainTheme } from "pi-cosmic-core/testing";
import {
  createSettingsListSurface,
  managerSettingsTheme,
  settingInherited,
  withSettingsGroupChildren,
  type SettingsSurfaceItem,
} from "../src/manager/settings-surface.ts";

const ESC = "\u001b";

beforeEach(() => setKeybindings(new TuiKeybindingsManager(TUI_KEYBINDINGS)));

/**
 * Two scopes whose `limit` rows save to one store: Project inherits Global's value, so its row,
 * choices, and summary depend on Global's latest save.
 */
const scopedSurface = () => {
  const own = new Map<string, string | undefined>();
  const effective = (scope: string): string =>
    own.get(scope) ?? (scope === "project" ? effective("global") : "8");
  const inherited = (scope: string) =>
    settingInherited(scope === "project" ? effective("global") : "8");
  const row = (scope: string): SettingsSurfaceItem => ({
    id: `${scope}:limit`,
    label: `${scope} limit`,
    currentValue: own.get(scope) ?? inherited(scope),
    values: ["4", "16", inherited(scope)],
  });
  const group = (scope: string): SettingsSurfaceItem => ({
    id: `group:${scope}`,
    label: scope,
    currentValue: `${effective(scope)} running`,
    children: () => [row(scope)],
    summary: () => `${effective(scope)} running`,
  });
  const items = withSettingsGroupChildren(
    [group("global"), group("project")],
    managerSettingsTheme(plainTheme),
    (id, value, show) => {
      const [scope] = Str.split(id, ":");
      own.set(scope, Fn.pipe(value, Str.startsWith("inherit")) ? undefined : value);
      show(own.get(scope) ?? inherited(scope));
    },
  );
  const created = createSettingsListSurface({
    header: new Text("Settings", 0, 0),
    items,
    height: items.length,
    listTheme: managerSettingsTheme(plainTheme),
    onChange: () => undefined,
    onCancel: () => undefined,
    matchesKeybinding: undefined,
    requestRender: () => undefined,
    dim: (text) => text,
    bridge: {},
  });
  const lines = () => created.surface.render(80);
  return {
    press: (...keys: string[]) => {
      for (const key of keys) created.surface.handleInput?.(key);
    },
    lines,
    line: (start: string) =>
      Option.getOrElse(
        Arr.findFirst(lines(), (entry) =>
          Fn.pipe(Str.trim(Str.replace(/^›/u, "")(entry)), Str.startsWith(start)),
        ),
        () => "",
      ),
  };
};

describe("settings surface live values", () => {
  it("re-derives a group's rows and choices on open and refreshes every group summary", () => {
    const surface = scopedSurface();
    // Global's limit, from its inherited 8 to 16.
    surface.press("\r", "\r");
    expect(surface.line("(•)")).toContain("inherit (8)");
    surface.press("j", "j", "\r", ESC);
    // Project's summary follows Global's save without Project being opened.
    expect(surface.line("global")).toContain("16 running");
    expect(surface.line("project")).toContain("16 running");
    // Project's inherited row and its choice list name the new value.
    surface.press("j", "\r");
    expect(surface.line("project limit")).toContain("inherit (16)");
    surface.press("\r");
    expect(surface.line("(•)")).toContain("inherit (16)");
    surface.press(ESC, ESC);
    // Restoring Global's inheritance shows the default again everywhere.
    surface.press("k", "\r", "\r", "k", "k", "\r", ESC);
    expect(surface.line("project")).toContain("8 running");
    surface.press("j", "\r");
    expect(surface.line("project limit")).toContain("inherit (8)");
  });

  it("puts the inherit choice first in every choice list", () => {
    const surface = scopedSurface();
    surface.press("\r", "\r");
    const choices = Arr.filter(surface.lines(), (entry) =>
      Fn.pipe(Str.trim(Str.replace(/^›/u, "")(entry)), Str.startsWith("(")),
    );
    expect(Arr.map(choices, (entry) => Str.trim(Str.replace(/^›/u, "")(entry)))).toEqual([
      "(•) inherit (8)",
      "( ) 4",
      "( ) 16",
    ]);
  });
});
