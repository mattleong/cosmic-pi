import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Arr from "effect/Array";
import type { CodePreviewSettings } from "./schema";

type SettingKey = keyof CodePreviewSettings;

export interface SettingsAdmission {
  readonly sequence: number;
}

export interface SettingsCoordinator {
  /** Publishes a load and its resolution baseline unless a later admission already published. */
  readonly publishIfCurrent: (baseline: CodePreviewSettings, publish: () => void) => boolean;
  /** Whether a later admission already published an edit to one of these keys. */
  readonly isSuperseded: (keys: readonly SettingKey[]) => boolean;
  /**
   * Publishes an edit resolved against the baseline that owns the shared projection: its own when it
   * is the newest publication, otherwise the newest published one, so an overtaken edit cannot
   * restore another session's project context.
   */
  readonly publishEdit: (
    keys: readonly SettingKey[],
    baseline: CodePreviewSettings,
    publish: (baseline: CodePreviewSettings) => void,
  ) => void;
}

// The semaphore does not grant permits in admission order, so an earlier edit may run after a
// later one. Edits are ordered per key by admission; publication context follows the newest
// publication instead.
const settingsPermit = Semaphore.makeUnsafe(1);
let nextAdmission = 0;
let latestSuccessfulPublication = 0;
let latestPublishedBaseline: CodePreviewSettings | undefined;
const latestKeyEdits = new Map<SettingKey, number>();

export function nextSettingsAdmission(): SettingsAdmission {
  return { sequence: ++nextAdmission };
}

export function withSettingsCoordinator<A, E, R>(
  admission: SettingsAdmission,
  use: (coordinator: SettingsCoordinator) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return settingsPermit.withPermit(
    Effect.suspend(() => {
      const isCurrent = () => admission.sequence > latestSuccessfulPublication;
      const advance = (baseline: CodePreviewSettings) => {
        latestSuccessfulPublication = admission.sequence;
        latestPublishedBaseline = baseline;
      };
      return use({
        publishIfCurrent: (baseline, publish) => {
          if (!isCurrent()) return false;
          publish();
          advance(baseline);
          return true;
        },
        isSuperseded: (keys) =>
          Arr.some(keys, (key) => (latestKeyEdits.get(key) ?? 0) > admission.sequence),
        publishEdit: (keys, baseline, publish) => {
          if (isCurrent()) {
            publish(baseline);
            advance(baseline);
          } else publish(latestPublishedBaseline ?? baseline);
          for (const key of keys)
            latestKeyEdits.set(key, Math.max(latestKeyEdits.get(key) ?? 0, admission.sequence));
        },
      });
    }),
  );
}

export const flushSettingsCoordinator: Effect.Effect<void> = settingsPermit.withPermit(Effect.void);
