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
  signal?: AbortSignal,
): Promise<CodePreviewSettings> {
  const effect = loadCodePreviewSettingsEffect(projectCwd, projectTrusted);
  const execute = (): Promise<CodePreviewSettings> => {
    // A replacement may dispose the previously published session capability between the synchronous
    // capability check and execution. Retry through the serialized one-shot boundary unless the
    // requesting startup itself was cancelled.
    if (!hasCodePreviewSessionCapability()) return runOneShotSettingsEffect(effect, signal);
    return runCodePreviewSessionEffect(effect, signal).catch((error) =>
      signal?.aborted ? Promise.reject(error) : runOneShotSettingsEffect(effect, signal),
    );
  };

  // A signal gives one startup sole cancellation ownership. Sharing its Promise with another
  // startup would let either session interrupt the other's settings load.
  if (signal) return execute();

  const key = JSON.stringify([projectCwd ?? null, projectTrusted]);
  const inFlight = inFlightLoads.get(key);
  if (inFlight) return inFlight;
  const load = execute();
  inFlightLoads.set(key, load);
  const settle = () => {
    if (inFlightLoads.get(key) === load) inFlightLoads.delete(key);
  };
  load.then(settle, settle);
  return load;
}
