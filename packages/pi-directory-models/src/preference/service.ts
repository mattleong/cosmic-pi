import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { PiApi } from "pi-cosmic-core";
import {
  applyHostPreference,
  captureContextModel,
  preferenceFromSelectedModel,
} from "../boundary/host-model.ts";
import type { DirectoryModelPreference } from "../config/schema.ts";
import { DirectoryModelStore, type DirectoryIdentity } from "../config/store.ts";

export interface DirectoryModelSessionInput {
  readonly ctx: ExtensionContext;
  readonly cwd: string;
  readonly fresh: boolean;
  readonly explicitPreference: boolean;
}

/**
 * Total, nonthrowing host notifier. `warnOnce` invokes it inside `Effect.sync`,
 * and the only supplier is `notifyAtHostBoundary`, which already absorbs host failures.
 */
export type DirectoryModelWarn = (message: string) => void;

const READ_WARNING = "The saved model for this directory is invalid, so Pi kept its current model";
const IDENTIFY_WARNING = "Couldn't identify this directory to remember its model";
export const WRITE_WARNING = "Couldn't save the model for this directory";

export class DirectoryModelPreferenceService extends Context.Service<DirectoryModelPreferenceService>()(
  "pi-directory-models/preference/service/DirectoryModelPreferenceService",
  {
    make: (input: DirectoryModelSessionInput, warn: DirectoryModelWarn) =>
      Effect.gen(function* () {
        const pi = yield* PiApi;
        const store = yield* DirectoryModelStore;
        const gate = yield* Semaphore.make(1);
        // Every access to these session-local values occurs under the single-permit gate.
        let cachedIdentity: DirectoryIdentity | undefined;
        const warned = new Set<string>();

        const warnOnce = (key: string, message: string) =>
          Effect.sync(() => {
            if (warned.has(key)) return;
            warned.add(key);
            warn(message);
          });

        /** Recover any failure into `undefined` after one warning per key. */
        const recovered = <Value, E>(
          effect: Effect.Effect<Value, E>,
          key: string,
          message: string,
        ): Effect.Effect<Value | undefined> =>
          Effect.catch(effect, () => Effect.as(warnOnce(key, message), undefined));

        const identity = Effect.gen(function* () {
          if (cachedIdentity) return cachedIdentity;
          const identified = yield* store.identify(input.cwd);
          cachedIdentity = identified;
          return identified;
        });

        const write = (identified: DirectoryIdentity, preference: DirectoryModelPreference) =>
          recovered(store.write(identified, preference), "write", WRITE_WARNING);

        // Snapshot the live session model and Pi's thinking level at serialized capture time
        // so a delayed host event re-persists the current state instead of a stale one.
        // An absent or malformed session model yields `undefined` without a warning.
        const currentPreference = (canonicalCwd: string) =>
          Effect.suspend(() => {
            const selected = captureContextModel(input.ctx);
            if (!selected) return Effect.undefined;
            return recovered(
              preferenceFromSelectedModel(pi, canonicalCwd, selected),
              "current",
              "Couldn't read Pi's current model",
            );
          });

        const remember = gate.withPermit(
          Effect.gen(function* () {
            const identified = yield* recovered(identity, "identify", IDENTIFY_WARNING);
            if (!identified) return;
            const preference = yield* currentPreference(identified.canonicalCwd);
            if (!preference) return;
            yield* write(identified, preference);
          }),
        );

        const initialize = gate.withPermit(
          Effect.gen(function* () {
            if (!input.fresh || input.explicitPreference) return;
            const identified = yield* recovered(identity, "identify", IDENTIFY_WARNING);
            if (!identified) return;
            // None means the read failed (already warned); Some(undefined) means no document.
            const loaded = yield* store.read(identified).pipe(
              Effect.tapError(() => warnOnce("read", READ_WARNING)),
              Effect.option,
            );
            if (Option.isNone(loaded)) return;
            const loadedPreference = loaded.value;
            if (!loadedPreference) {
              const current = yield* currentPreference(identified.canonicalCwd);
              if (current) yield* write(identified, current);
              return;
            }
            // Restoration runs inside pre-activation startup: the session slot admits host
            // events only after this whole Effect resolves, and setModel settlement is
            // awaited (uninterruptibly) before that point, so no restore marker is needed.
            const restored = yield* applyHostPreference(pi, input.ctx, loadedPreference).pipe(
              Effect.catch((error) =>
                Effect.as(warnOnce(`restore:${error.operation}`, error.message), undefined),
              ),
            );
            if (restored) yield* write(identified, restored);
          }),
        );

        return { initialize, remember };
      }),
  },
) {}
