import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  ProfileSetSaveFormComponent,
  type ProfileSetSaveDestination,
} from "../src/settings/profile-set-save-form.ts";

// SAFETY: Only these theme methods are used by the form.
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
const form = (projectTrusted = true) => {
  const close = vi.fn<(value: ProfileSetSaveDestination | undefined) => void>();
  return {
    close,
    component: new ProfileSetSaveFormComponent({
      theme,
      projectTrusted,
      initialScope: "project",
      getHeight: () => 8,
      requestRender: vi.fn(),
      close,
    }),
  };
};
describe("session snapshot form", () => {
  it("submits destination and normalized name together", () => {
    const { component, close } = form();
    for (const key of "  session copy  ") component.handleInput(key);
    component.handleInput("\r");
    expect(close).toHaveBeenCalledWith({ scope: "project", name: "session copy" });
  });
  it("keeps invalid names editable and never emits a partial result", () => {
    const { component, close } = form();
    component.handleInput("\r");
    expect(close).not.toHaveBeenCalled();
    component.handleInput("x");
    component.handleInput("\r");
    expect(close).toHaveBeenCalledWith({ scope: "project", name: "x" });
  });
  it("keeps text shortcuts inside the name input and cancels without saving", () => {
    const { component, close } = form();
    for (const key of "sumpr") component.handleInput(key);
    expect(close).not.toHaveBeenCalled();
    component.handleInput("\u001b");
    expect(close).toHaveBeenCalledWith(undefined);
  });
  it("does not expose Project as a destination without trust", () => {
    const { component, close } = form(false);
    component.handleInput("\u001b[Z");
    component.handleInput("\u001b[C");
    component.handleInput("\t");
    component.handleInput("x");
    component.handleInput("\r");
    expect(close).toHaveBeenCalledWith({ scope: "global", name: "x" });
  });
  it("allows changing the destination without discarding the name", () => {
    const { component, close } = form();
    component.handleInput("x");
    component.handleInput("\u001b[Z");
    component.handleInput("\u001b[C");
    component.handleInput("\r");
    component.handleInput("\r");
    expect(close).toHaveBeenCalledWith({ scope: "global", name: "x" });
  });
  it("ignores input after disposal", () => {
    const { component, close } = form();
    component.dispose();
    component.handleInput("\u001b");
    expect(close).not.toHaveBeenCalled();
  });
});
