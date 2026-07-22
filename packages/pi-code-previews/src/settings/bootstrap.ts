import * as Effect from "effect/Effect";
import {
  hasCodePreviewSessionCapability,
  runCodePreviewSessionEffect,
} from "../application/capability";
import { runOneShotSettingsEffect } from "../boundary/settings-one-shot";
import { CodePreviewSettingsService } from "../config/service";
import type { CodePreviewSettings } from "../config/schema";

export const loadCodePreviewSettingsEffect = Effect.fn("CodePreviewSettings.bootstrap")(function* (
  projectCwd?: string,
  projectTrusted = false,
) {
  const service = yield* CodePreviewSettingsService;
  return yield* service.load({
    ...(projectCwd === undefined ? {} : { projectCwd }),
    projectTrusted,
  });
});

/** Public pre-session compatibility uses the single named one-shot settings adapter. */
export function loadCodePreviewSettings(
  projectCwd?: string,
  projectTrusted = false,
): Promise<CodePreviewSettings> {
  const effect = loadCodePreviewSettingsEffect(projectCwd, projectTrusted);
  return hasCodePreviewSessionCapability()
    ? runCodePreviewSessionEffect(effect)
    : runOneShotSettingsEffect(effect);
}
