import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import {
  hasCodePreviewSessionCapability,
  runCodePreviewSessionEffect,
} from "../application/capability";
import { nodeJoin } from "../boundary/node";
import { runOneShotSettingsEffect } from "../boundary/settings-one-shot";
import type { LoadSettingsOptions } from "./document-store";
import type { CodePreviewSettings } from "./schema";
import { CodePreviewSettingsService } from "./service";
import { cloneCodePreviewSettings } from "./state";

export type { LoadSettingsOptions } from "./document-store";
/** Effect settings persistence service — preferred session door. */
export {
  CodePreviewSettingsService,
  settingsSaveContextProjection,
  type CodePreviewSettingsServiceShape,
  type CodePreviewSettingsState,
} from "./service";

/** Run a settings Effect on the live session runtime, or a one-shot runtime when idle. */
function runSettingsEffect<A, E>(effect: Effect.Effect<A, E, CodePreviewSettingsService>) {
  return hasCodePreviewSessionCapability()
    ? runCodePreviewSessionEffect(effect)
    : runOneShotSettingsEffect(effect);
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
  const next = cloneCodePreviewSettings(settings);
  if (hasCodePreviewSessionCapability()) {
    return runCodePreviewSessionEffect(
      CodePreviewSettingsService.use((service) => service.save(next)),
    );
  }

  // A one-shot runtime cannot retain service state. Rehydrate its authoritative save context from
  // disk, then save within that same service instance.
  return runOneShotSettingsEffect(
    CodePreviewSettingsService.use((service) =>
      service.loadFromDisk(loadOptions).pipe(Effect.andThen(service.save(next))),
    ),
  );
}

export function flushSettingsSaveQueue(): Promise<void> {
  return runSettingsEffect(CodePreviewSettingsService.use((service) => service.flush));
}

export function formatSettingsSaveError(error: unknown): string {
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "Unknown error.";
  return `Failed to save code preview settings: ${message}`;
}
