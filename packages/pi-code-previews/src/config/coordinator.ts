import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/** Process-local admission captured before settings work can cross a runtime boundary. */
export interface SettingsAdmission {
  readonly sequence: number;
}

export interface SettingsCoordinator {
  /** Lock-free while the caller holds the coordinator permit. */
  readonly isCurrent: () => boolean;
  /** Publish and advance currency only when this admission is still current. */
  readonly publishIfCurrent: (publish: () => void) => boolean;
}

const settingsPermit = Semaphore.makeUnsafe(1);
let nextAdmission = 0;
let latestSuccessfulPublication = 0;

export function makeSettingsAdmission(): SettingsAdmission {
  return { sequence: ++nextAdmission };
}

/** Serialize settings work across every Layer and one-shot runtime in this process. */
export function withSettingsCoordinator<A, E, R>(
  admission: SettingsAdmission,
  use: (coordinator: SettingsCoordinator) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return settingsPermit.withPermit(
    Effect.suspend(() => {
      const isCurrent = () => admission.sequence > latestSuccessfulPublication;
      return use({
        isCurrent,
        publishIfCurrent: (publish) => {
          if (!isCurrent()) return false;
          publish();
          latestSuccessfulPublication = admission.sequence;
          return true;
        },
      });
    }),
  );
}

/** Global barrier behind settings work admitted by any runtime. */
export const flushSettingsCoordinator: Effect.Effect<void> = settingsPermit.withPermit(Effect.void);
