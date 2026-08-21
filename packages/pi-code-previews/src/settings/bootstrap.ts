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
  return yield* service.load(
    projectCwd === undefined ? { projectTrusted } : { projectCwd, projectTrusted },
  );
});

const inFlightLoads = new Map<string, Promise<CodePreviewSettings>>();

/** Public pre-session compatibility uses the single named one-shot settings adapter. */
export function loadCodePreviewSettings(
  projectCwd?: string,
  projectTrusted = false,
): Promise<CodePreviewSettings> {
  const key = JSON.stringify([projectCwd ?? null, projectTrusted]);
  const inFlight = inFlightLoads.get(key);
  if (inFlight) return inFlight;
  const effect = loadCodePreviewSettingsEffect(projectCwd, projectTrusted);
  // A replacement may dispose the previously published session capability between the synchronous
  // capability check and execution. Retry through the serialized one-shot boundary so consumers never
  // capture stale/default shell settings merely because extension session handlers ran in a
  // different order.
  const load = hasCodePreviewSessionCapability()
    ? runCodePreviewSessionEffect(effect).catch(() => runOneShotSettingsEffect(effect))
    : runOneShotSettingsEffect(effect);
  inFlightLoads.set(key, load);
  const settle = () => {
    if (inFlightLoads.get(key) === load) inFlightLoads.delete(key);
  };
  load.then(settle, settle);
  return load;
}
