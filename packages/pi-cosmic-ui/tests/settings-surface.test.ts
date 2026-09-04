import { describe, expect, it, vi } from "vitest";
import {
  settingsItemsFromDescriptors,
  settingsRowGenerations,
  withoutGroupRowChanges,
} from "../src/manager/settings-surface.ts";

describe("shared settings surface helpers", () => {
  it("projects descriptors without sharing their mutable value arrays", () => {
    const values = ["off", "on"];
    const items = settingsItemsFromDescriptors(
      [
        {
          id: "enabled",
          label: "Enabled",
          description: "Toggle the feature",
          currentValue: (config: { readonly enabled: boolean }) => (config.enabled ? "on" : "off"),
          values,
        },
      ],
      { enabled: true },
    );
    expect(items[0]).toMatchObject({ id: "enabled", currentValue: "on" });
    expect(items[0]?.values).not.toBe(values);
  });

  it("never forwards group navigation rows as setting changes", () => {
    const change = vi.fn();
    const handle = withoutGroupRowChanges(
      [
        { id: "group", label: "Group", currentValue: "open", kind: "group" },
        { id: "value", label: "Value", currentValue: "on", kind: "setting" },
      ],
      change,
    );
    handle("group", "ignored");
    handle("value", "off");
    expect(change).toHaveBeenCalledOnce();
    expect(change).toHaveBeenCalledWith("value", "off");
  });

  it("rejects stale optimistic row settlements", () => {
    const generations = settingsRowGenerations();
    const first = generations.begin("row");
    const second = generations.begin("row");
    expect(generations.isCurrent("row", first)).toBe(false);
    expect(generations.isCurrent("row", second)).toBe(true);
  });
});
