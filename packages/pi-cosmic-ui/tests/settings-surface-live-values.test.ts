import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { deferredPromise, plainTheme } from "pi-cosmic-core/testing";
import {
  managerSettingsTheme,
  settingInherited,
  withSettingsGroupChildren,
  type SettingsSurfaceItem,
} from "../src/manager/settings-surface.ts";
import { surfaceFor } from "./support/settings-surface.ts";

const ESC = "\u001b";

/** A rendered row without its cursor. */
const unmarked = (entry: string) => Str.trim(Fn.pipe(entry, Str.replace(/^›/u, "")));

/**
 * How a save reaches the store: at once, after `release` (a slow write), or optimistically at once
 * and then put back by `release` (a write that fails).
 */
type SaveTiming = "immediate" | "delayed" | "optimistic-failure";

/**
 * Two scopes whose `limit` rows save to one store: Project inherits Global's value, so its row,
 * choices, and summary depend on Global's latest save.
 */
const scopedSurface = (timing: SaveTiming = "immediate") => {
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
  const pending: Array<() => void> = [];
  const items = withSettingsGroupChildren(
    [group("global"), group("project")],
    managerSettingsTheme(plainTheme),
    (id, value, show) => {
      const [scope] = Str.split(id, ":");
      const chosen = Fn.pipe(value, Str.startsWith("inherit")) ? undefined : value;
      const store = () => own.set(scope, chosen);
      const shown = () => own.get(scope) ?? inherited(scope);
      if (timing === "immediate") {
        store();
        show(shown());
        return undefined;
      }
      const replaced = own.get(scope);
      if (timing === "optimistic-failure") store();
      const settled = deferredPromise();
      pending.push(() => {
        if (timing === "delayed") store();
        else own.set(scope, replaced);
        show(shown());
        settled.resolve();
      });
      return settled.promise;
    },
  );
  const { press, lines } = surfaceFor(items);
  return {
    press,
    // Settles every save still in flight, in the order they were made.
    release: () => Promise.all(Arr.map(pending.splice(0), (settle) => Promise.resolve(settle()))),
    lines,
    cursor: () =>
      Option.getOrElse(
        Arr.findFirst(lines(), (entry) => Fn.pipe(Str.trim(entry), Str.startsWith("›"))),
        () => "",
      ),
    line: (start: string) =>
      Option.getOrElse(
        Arr.findFirst(lines(), (entry) => Fn.pipe(unmarked(entry), Str.startsWith(start))),
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
    const choices = Arr.filter(Arr.map(surface.lines(), unmarked), Str.startsWith("("));
    expect(choices).toEqual(["(•) inherit (8)", "( ) 4", "( ) 16"]);
  });

  it.effect("updates an open group's rows and open choice list when an earlier save settles", () =>
    Effect.gen(function* () {
      const surface = scopedSurface("delayed");
      // Global's limit to 16; the write is still in flight when Project opens.
      surface.press("\r", "\r", "j", "j", "\r", ESC);
      surface.press("j", "\r");
      expect(surface.line("project limit")).toContain("inherit (8)");
      // Project's choice list is open, on its inherit choice, when Global's write lands.
      surface.press("\r");
      expect(surface.cursor()).toContain("inherit (8)");
      yield* Effect.promise(surface.release);
      expect(surface.line("(•)")).toContain("inherit (16)");
      // The cursor stays on the inherit choice whose value changed.
      expect(surface.cursor()).toContain("inherit (16)");
      surface.press(ESC);
      expect(surface.line("project limit")).toContain("inherit (16)");
    }),
  );

  it.effect("puts back an open group's inherited rows when an optimistic save rolls back", () =>
    Effect.gen(function* () {
      const surface = scopedSurface("optimistic-failure");
      surface.press("\r", "\r", "j", "j", "\r", ESC);
      surface.press("j", "\r");
      // The open Project group shows the value Global's save claims before it fails.
      expect(surface.line("project limit")).toContain("inherit (16)");
      yield* Effect.promise(surface.release);
      expect(surface.line("project limit")).toContain("inherit (8)");
      surface.press("\r");
      expect(surface.line("(•)")).toContain("inherit (8)");
      surface.press(ESC, ESC);
      expect(surface.line("project")).toContain("8 running");
    }),
  );
});
