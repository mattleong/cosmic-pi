import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

export interface SettingsAdmission {
  readonly sequence: number;
}

export interface SettingsCoordinator {
  readonly isCurrent: () => boolean;
  readonly publishIfCurrent: (publish: () => void) => boolean;
}

const settingsPermit = Semaphore.makeUnsafe(1);
let nextAdmission = 0;
let latestSuccessfulPublication = 0;

export function makeSettingsAdmission(): SettingsAdmission {
  return { sequence: ++nextAdmission };
}

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

export const flushSettingsCoordinator: Effect.Effect<void> = settingsPermit.withPermit(Effect.void);
