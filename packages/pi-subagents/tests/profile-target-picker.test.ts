import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ProfileTargetPickerComponent } from "../src/settings/profile-target-picker.ts";
import type { ProfileWorkspaceTarget } from "../src/settings/profile-route-editor.ts";
import { makeProfileSettingsInspection } from "./fixtures/profile-settings-inspection.ts";

// SAFETY: The selector uses these fixture theme methods only.
const theme = {
  fg: (_: string, text: string) => text,
  bg: (_: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const picker = (trusted = true) => {
  const close = vi.fn<(value: ProfileWorkspaceTarget | undefined) => void>();
  const inspection = makeProfileSettingsInspection({
    globalDocument: { version: 6, profileSets: { global: { profiles: {} } } },
    projectDocument: { version: 6, profileSets: { project: { profiles: {} } } },
    projectTrusted: trusted,
  });
  return {
    close,
    component: new ProfileTargetPickerComponent({
      theme,
      inspection,
      projectTrusted: trusted,
      target: { kind: "session" },
      getHeight: () => 8,
      requestRender: vi.fn(),
      close,
    }),
  };
};
describe("profile target selector", () => {
  it("can return to Current Session without applying a saved set", () => {
    const { component, close } = picker();
    component.handleInput("\r");
    expect(close).toHaveBeenCalledWith({ kind: "session" });
  });
  it("selects a saved target directly", () => {
    const { component, close } = picker();
    component.handleInput("j");
    component.handleInput("\r");
    expect(close).toHaveBeenCalledWith({
      kind: "profile-set",
      set: { scope: "project", name: "project" },
    });
  });
  it("cannot choose an untrusted Project target", () => {
    const { component, close } = picker(false);
    component.handleInput("j");
    component.handleInput("\r");
    expect(close).not.toHaveBeenCalled();
    component.handleInput("j");
    component.handleInput("\r");
    expect(close).toHaveBeenCalledWith({
      kind: "profile-set",
      set: { scope: "global", name: "global" },
    });
  });
  it("cancels without changing the target", () => {
    const { component, close } = picker();
    component.handleInput("j");
    component.handleInput("\u001b");
    expect(close).toHaveBeenCalledWith(undefined);
  });
});
