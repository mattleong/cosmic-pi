import * as Effect from "effect/Effect";
import { runSerializedPlatformEffect } from "../boundary/platform";
import { defaultCodePreviewSettings } from "./defaults";
import { cloneCodePreviewSettings, codePreviewSettings, setCodePreviewSettings } from "./state";
import {
  loadSettingsFromDiskUnlockedEffect,
  settingsBoundaryLock,
  settingsCoordinationLock,
} from "./store";
import type { CodePreviewSettings } from "./types";

export const loadCodePreviewSettingsEffect = Effect.fn("CodePreviewSettings.bootstrap")(function* (
  projectCwd?: string,
  projectTrusted = false,
) {
  return yield* settingsCoordinationLock.withPermits(1)(
    Effect.gen(function* () {
      const savedSettings = yield* loadSettingsFromDiskUnlockedEffect({
        ...(projectCwd === undefined ? {} : { projectCwd }),
        projectTrusted,
      });
      setCodePreviewSettings(savedSettings ?? defaultCodePreviewSettings);
      return cloneCodePreviewSettings(codePreviewSettings);
    }),
  );
});

/** Public Promise boundary retained for package integrations. */
export function loadCodePreviewSettings(
  projectCwd?: string,
  projectTrusted = false,
): Promise<CodePreviewSettings> {
  return runSerializedPlatformEffect(
    settingsBoundaryLock,
    loadCodePreviewSettingsEffect(projectCwd, projectTrusted),
  );
}
