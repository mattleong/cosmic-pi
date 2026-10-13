import { failureMessage, formatDisplayPath } from "pi-cosmic-core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import {
  hasCodePreviewSessionCapability,
  runCodePreviewSessionEffect,
} from "../application/capability";
import { nodeJoin } from "../boundary/node";
import { runOneShotSettingsEffect } from "../boundary/settings-one-shot";
import { makeSettingsAdmission, type SettingsAdmission } from "./coordinator";
import type { CodePreviewSettings } from "./schema";
import {
  CodePreviewSettingsService,
  type LoadSettingsOptions,
  type SettingsLoadProblem,
} from "./service";
import { cloneCodePreviewSettings } from "./state";

export {
  CodePreviewSettingsService,
  type CodePreviewSettingsServiceContract,
  type LoadSettingsOptions,
  type SettingsLoadProblem,
} from "./service";

function runSettingsEffect<A, E>(effect: Effect.Effect<A, E, CodePreviewSettingsService>) {
  return hasCodePreviewSessionCapability()
    ? runCodePreviewSessionEffect(effect)
    : runOneShotSettingsEffect(effect);
}

const inFlightLoads = new Map<string, Promise<CodePreviewSettings>>();

export function loadCodePreviewSettings(
  projectCwd?: string,
  projectTrusted = false,
  signal?: AbortSignal,
): Promise<CodePreviewSettings> {
  const execute = (admission: SettingsAdmission): Promise<CodePreviewSettings> => {
    const effect = CodePreviewSettingsService.use((service) =>
      service.load(admission, { projectCwd, projectTrusted }),
    );
    if (!hasCodePreviewSessionCapability()) return runOneShotSettingsEffect(effect, signal);
    return runCodePreviewSessionEffect(effect, signal).catch((cause: unknown) => {
      if (signal?.aborted) throw cause;
      return runOneShotSettingsEffect(effect, signal);
    });
  };

  if (signal) return execute(makeSettingsAdmission());

  const key = JSON.stringify([projectCwd ?? null, projectTrusted]);
  const inFlight = inFlightLoads.get(key);
  if (inFlight) return inFlight.then(cloneCodePreviewSettings);
  const load = execute(makeSettingsAdmission());
  inFlightLoads.set(key, load);
  const settle = () => {
    if (inFlightLoads.get(key) === load) inFlightLoads.delete(key);
  };
  void load.then(settle, settle);
  return load.then(cloneCodePreviewSettings);
}

export function getSettingsPath(): string {
  return nodeJoin(getAgentDir(), "code-previews.json");
}

export function queueSettingsSave(
  settings: CodePreviewSettings,
  loadOptions: LoadSettingsOptions = {},
  previous?: CodePreviewSettings,
): Promise<void> {
  const admission = makeSettingsAdmission();
  const next = cloneCodePreviewSettings(settings);
  const options = {
    ...(!hasCodePreviewSessionCapability() && { rehydrate: loadOptions }),
    ...(previous && { previous: cloneCodePreviewSettings(previous) }),
  };
  return runSettingsEffect(
    CodePreviewSettingsService.use((service) => service.save(next, admission, options)),
  );
}

export function queueSettingsReset(loadOptions: LoadSettingsOptions = {}): Promise<void> {
  const admission = makeSettingsAdmission();
  const options = hasCodePreviewSessionCapability() ? {} : { rehydrate: loadOptions };
  return runSettingsEffect(
    CodePreviewSettingsService.use((service) => service.reset(admission, options)),
  );
}

export function flushSettingsSaveQueue(): Promise<void> {
  return runSettingsEffect(CodePreviewSettingsService.use((service) => service.flush));
}

export function formatSettingsSaveError(cause: unknown): string {
  const message =
    Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)
      ? failureMessage(cause.message, "unknown error")
      : "unknown error";
  return `Couldn't save code preview settings: ${message}`;
}

export function describeSettingsProblem(problem: SettingsLoadProblem, cwd: string): string {
  const file = formatDisplayPath(problem.path, cwd);
  return problem.fields
    ? `Code Previews ignored invalid settings in ${file}: ${problem.fields.join(", ")}`
    : `Code Previews couldn't read its settings in ${file}`;
}
