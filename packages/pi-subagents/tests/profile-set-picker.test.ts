import { describe, expect, it, vi } from "vitest";
import {
  INVALID_ROUTE,
  profileSettingsInspection,
} from "./fixtures/profile-settings-inspection.ts";
import { plainTheme } from "pi-cosmic-core/testing";
import {
  ProfileSetPickerComponent,
  type ProfileSetPickerAction,
} from "../src/settings/profile-set-picker.ts";
import type { ProfileSettingsInspection } from "../src/settings/profile-route-editor.ts";
import { profileSetPickerEntries } from "../src/settings/ui/profile-set-picker-model.ts";

const globalDocument = {
  version: 6,
  defaultProfileSet: "gold",
  profileSets: {
    common: { profiles: {} },
    gold: { profiles: {} },
  },
};

const projectDocument = {
  version: 6,
  defaultProfileSet: "project",
  profileSets: {
    common: { profiles: {} },
    project: { profiles: {} },
  },
};

const inspection = (): ProfileSettingsInspection =>
  profileSettingsInspection({ globalDocument, projectDocument, projectTrusted: true });

const invalidInspection = (): ProfileSettingsInspection =>
  profileSettingsInspection({
    globalDocument: {
      version: 6,
      profileSets: { broken: { profiles: { worker: INVALID_ROUTE } }, valid: { profiles: {} } },
    },
    projectTrusted: false,
  });

const makePicker = (
  options: {
    readonly value?: ProfileSettingsInspection;
    readonly projectTrusted?: boolean;
    readonly height?: number;
  } = {},
) => {
  const close = vi.fn<(action: ProfileSetPickerAction | undefined) => void>();
  const component = new ProfileSetPickerComponent({
    theme: plainTheme,
    inspection: options.value ?? inspection(),
    projectTrusted: options.projectTrusted ?? true,
    getHeight: () => options.height ?? 30,
    requestRender: vi.fn(),
    close,
  });
  return { close, component };
};

describe("saved profile-set library", () => {
  it("keeps untrusted Project entries visible but unavailable", () => {
    const entries = profileSetPickerEntries(inspection(), false);
    expect(entries[0]).toMatchObject({ kind: "scope-note", key: "project:locked" });

    const picker = makePicker({ projectTrusted: false });
    picker.component.handleInput("g");
    picker.component.handleInput("g");
    picker.component.handleInput("\r");
    expect(picker.close).not.toHaveBeenCalled();
  });

  it("blocks Use for invalid sets without preventing repair", () => {
    const picker = makePicker({ value: invalidInspection(), projectTrusted: false });
    picker.component.handleInput("u");
    expect(picker.close).not.toHaveBeenCalled();
    picker.component.handleInput("\r");
    expect(picker.close).toHaveBeenCalledWith({
      action: "edit",
      target: { scope: "global", name: "broken" },
    });
  });
});
