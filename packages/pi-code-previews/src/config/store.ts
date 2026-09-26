import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import {
  hasCodePreviewSessionCapability,
  runCodePreviewSessionEffect,
} from "../application/capability";
import { nodeJoin } from "../boundary/node";
import { runOneShotSettingsEffect } from "../boundary/settings-one-shot";
import { makeSettingsAdmission, type SettingsAdmission } from "./coordinator";
import type { LoadSettingsOptions } from "./document-store";
import type { CodePreviewSettings } from "./schema";
import { CodePreviewSettingsService } from "./service";
import { cloneCodePreviewSettings } from "./state";

export type { LoadSettingsOptions } from "./document-store";
/** Effect settings persistence service — preferred session door. */
export { CodePreviewSettingsService, type CodePreviewSettingsServiceContract } from "./service";

/** Run a settings Effect on the live session runtime, or a one-shot runtime when idle. */
function runSettingsEffect<A, E>(effect: Effect.Effect<A, E, CodePreviewSettingsService>) {
  return hasCodePreviewSessionCapability()
    ? runCodePreviewSessionEffect(effect)
    : runOneShotSettingsEffect(effect);
}

const loadCodePreviewSettingsEffect = (
  admission: SettingsAdmission,
  projectCwd?: string,
  projectTrusted = false,
) =>
  CodePreviewSettingsService.use((service) =>
    service.load(
      admission,
      projectCwd === undefined ? { projectTrusted } : { projectCwd, projectTrusted },
    ),
  );

const inFlightLoads = new Map<string, Promise<CodePreviewSettings>>();

/** Load settings through the live session, or through the one-shot boundary when idle. */
export function loadCodePreviewSettings(
  projectCwd?: string,
  projectTrusted = false,
  signal?: AbortSignal,
): Promise<CodePreviewSettings> {
  const execute = (admission: SettingsAdmission): Promise<CodePreviewSettings> => {
    const effect = loadCodePreviewSettingsEffect(admission, projectCwd, projectTrusted);
    // A replacement may dispose the published session capability between this check and execution.
    // Retry through one-shot loading unless this requesting startup was cancelled.
    if (!hasCodePreviewSessionCapability()) return runOneShotSettingsEffect(effect, signal);
    return runCodePreviewSessionEffect(effect, signal).catch((error) =>
      signal?.aborted ? Promise.reject(error) : runOneShotSettingsEffect(effect, signal),
    );
  };

  // A signalled startup owns its cancellation and admission. Sharing either would let one session
  // interrupt another session's settings load.
  if (signal) return execute(makeSettingsAdmission());

  const key = JSON.stringify([projectCwd ?? null, projectTrusted]);
  const inFlight = inFlightLoads.get(key);
  if (inFlight) return inFlight.then(cloneCodePreviewSettings);
  const load = execute(makeSettingsAdmission());
  inFlightLoads.set(key, load);
  const settle = () => {
    if (inFlightLoads.get(key) === load) inFlightLoads.delete(key);
  };
  load.then(settle, settle);
  return load.then(cloneCodePreviewSettings);
}

/** Synchronous health-panel projection; persistence resolves AgentDirectory in Effect. */
export function getSettingsPath(): string {
  return nodeJoin(getAgentDir(), "code-previews.json");
}

/** Queue a settings save through the session runtime, or a one-shot runtime when idle. */
export function queueSettingsSave(
  settings: CodePreviewSettings,
  loadOptions: LoadSettingsOptions = {},
): Promise<void> {
  const admission = makeSettingsAdmission();
  const next = cloneCodePreviewSettings(settings);
  const options = hasCodePreviewSessionCapability() ? {} : { rehydrate: loadOptions };
  return runSettingsEffect(
    CodePreviewSettingsService.use((service) => service.save(next, admission, options)),
  );
}

export function flushSettingsSaveQueue(): Promise<void> {
  return runSettingsEffect(CodePreviewSettingsService.use((service) => service.flush));
}

export function formatSettingsSaveError<ErrorInput>(error: ErrorInput): string {
  const message =
    Predicate.hasProperty(error, "message") && Predicate.isString(error.message)
      ? error.message
      : "Unknown error.";
  return `Failed to save code preview settings: ${message}`;
}
