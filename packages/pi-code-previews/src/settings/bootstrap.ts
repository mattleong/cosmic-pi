import * as Effect from "effect/Effect";
import {
  hasCodePreviewSessionCapability,
  runCodePreviewSessionEffect,
} from "../application/capability";
import { runOneShotSettingsEffect } from "../boundary/settings-one-shot";
import { CodePreviewSettingsService } from "../config/store";
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
  if (!hasCodePreviewSessionCapability()) return runOneShotSettingsEffect(effect);
  // A replacement may dispose the previously published session capability between the synchronous
  // check above and execution. Retry through the serialized one-shot boundary so consumers never
  // capture stale/default shell settings merely because extension session handlers ran in a
  // different order.
  return runCodePreviewSessionEffect(effect).catch(() => runOneShotSettingsEffect(effect));
}
