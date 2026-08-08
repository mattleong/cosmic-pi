import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createSettingsListSurface } from "../src/manager/settings-surface.ts";

const listTheme = {
  label: (text: string) => text,
  value: (text: string) => text,
  description: (text: string) => text,
  cursor: "> ",
  hint: (text: string) => text,
};

const items = (): SettingItem[] => [
  { id: "enabled", label: "Enabled", currentValue: "true", values: ["true", "false"] },
  { id: "density", label: "Density", currentValue: "detailed", values: ["detailed", "compact"] },
];

describe("createSettingsListSurface", () => {
  it("composes header, list, and shared modeless hint into one focusable surface", () => {
    const { surface } = createSettingsListSurface({
      header: { render: () => ["Header"], invalidate: () => undefined },
      items: items(),
      height: 6,
      listTheme,
      onChange: () => undefined,
      onCancel: () => undefined,
      dim: (text) => `dim(${text})`,
    });
    surface.focused = true;
    const lines = surface.render(120);
    expect(lines[0]).toBe("Header");
    expect(lines.at(-1)).toContain("j/k move");
    expect(lines.at(-1)).toContain("/ filter");
    expect(surface.focused).toBe(true);
  });

  it("passes the composed list to onChange so callers can update values optimistically", () => {
    const changes: Array<{ id: string; value: string; sameList: boolean }> = [];
    let composed: SettingsList | undefined;
    const { list, surface } = createSettingsListSurface({
      header: { render: () => [], invalidate: () => undefined },
      items: items(),
      height: 6,
      listTheme,
      onChange: (id, value, changedList) => {
        changes.push({ id, value, sameList: changedList === composed });
      },
      onCancel: () => undefined,
      dim: (text) => text,
    });
    composed = list;
    surface.focused = true;
    surface.handleInput?.("\r");
    expect(changes).toEqual([{ id: "enabled", value: "false", sameList: true }]);
  });

  it("keeps cancel and bridge guards caller-owned", () => {
    let cancelled = 0;
    const invoked: string[] = [];
    const { surface } = createSettingsListSurface({
      header: { render: () => [], invalidate: () => undefined },
      items: items(),
      height: 6,
      listTheme,
      onChange: () => undefined,
      onCancel: () => {
        cancelled += 1;
      },
      dim: (text) => text,
      bridge: {
        invoke: (callback, fallback) => {
          invoked.push("guard");
          try {
            return callback();
          } catch {
            return fallback;
          }
        },
      },
    });
    surface.handleInput?.("");
    expect(cancelled).toBe(1);
    expect(invoked).toContain("guard");
  });
});

/**
 * VimSettingsAdapter deliberately couples to pi-tui SettingsList internals through the
 * structural `SettingsFocusableBridge` shape (`searchInput`, `submenuComponent`) and its
 * escape-sequence input translation. These probes pin the internals of the currently
 * pinned pi-tui version so an upgrade that changes them fails loudly here instead of
 * silently breaking search focus or submenu focus sync.
 */
describe("pi-tui SettingsList internal coupling probe", () => {
  it("still exposes the searchInput and submenuComponent internals the adapter relies on", () => {
    const list = new SettingsList(
      items(),
      6,
      listTheme,
      () => undefined,
      () => undefined,
      { enableSearch: true },
    ) as unknown as Record<string, unknown>;
    expect("searchInput" in list).toBe(true);
    expect(list.searchInput).toBeTruthy();
    expect(list.searchInput as object).toHaveProperty("focused");
    // Esc-from-search clearing relies on the search Input's setValue plus the list's
    // applyFilter internals of the pinned pi-tui version.
    expect(typeof (list.searchInput as { setValue?: unknown }).setValue).toBe("function");
    expect(typeof list.applyFilter).toBe("function");
    expect("submenuComponent" in list).toBe(true);
    expect(list.submenuComponent).toBeNull();
    // SettingsList itself has no `focused` field; the adapter's focus sync depends on that.
    expect("focused" in list).toBe(false);
  });

  it("focuses the real SettingsList search input when the adapter enters search mode", () => {
    const { surface } = createSettingsListSurface({
      header: { render: () => [], invalidate: () => undefined },
      items: items(),
      height: 6,
      listTheme,
      onChange: () => undefined,
      onCancel: () => undefined,
      dim: (text) => text,
    });
    surface.focused = true;
    surface.handleInput?.("/");
    const rendered = surface.render(80).join("\n");
    expect(rendered).toContain("Type to filter");
  });

  it("clears the real SettingsList filter when Esc dismisses search", () => {
    let cancelled = 0;
    const { surface } = createSettingsListSurface({
      header: { render: () => [], invalidate: () => undefined },
      items: items(),
      height: 6,
      listTheme,
      onChange: () => undefined,
      onCancel: () => {
        cancelled += 1;
      },
      dim: (text) => text,
    });
    surface.focused = true;
    surface.handleInput?.("/");
    for (const key of "den") surface.handleInput?.(key);
    expect(surface.render(80).join("\n")).not.toContain("Enabled");
    surface.handleInput?.(String.fromCharCode(27));
    const rendered = surface.render(80).join("\n");
    expect(rendered).toContain("Enabled");
    expect(rendered).toContain("Density");
    expect(rendered).not.toContain("den");
    // Esc left search without closing or cancelling the surface.
    expect(cancelled).toBe(0);
  });
});
