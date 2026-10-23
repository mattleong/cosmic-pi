import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { PiApi } from "pi-cosmic-core";
import {
  applyHostPreference,
  captureContextModel,
  preferenceFromSelectedModel,
  type DirectoryModelHost,
} from "../boundary/host-model.ts";
import type { DirectoryModelPreference } from "../config/schema.ts";
import {
  DirectoryModelStore,
  type DirectoryIdentity,
  type DirectoryModelStoreError,
} from "../config/store.ts";

export interface DirectoryModelSessionInput {
  readonly models: DirectoryModelHost;
  readonly cwd: string;
  readonly fresh: boolean;
  readonly explicitPreference: boolean;
}

export type DirectoryModelWarn = (message: string) => void;

const readWarning = (reason: DirectoryModelStoreError["reason"]) =>
  Match.value(reason).pipe(
    Match.when(
      "invalid",
      () => "The saved model for this directory is invalid, so Pi kept its current model",
    ),
    Match.when(
      "foreign",
      () =>
        "The saved model file for this directory belongs to another directory, so Pi kept its current model",
    ),
    Match.orElse(
      () => "Couldn't read the saved model for this directory, so Pi kept its current model",
    ),
  );
const THINKING_LEVEL_WARNING =
  "The thinking level saved for this directory is invalid, so Pi kept its current thinking level";
const IDENTIFY_WARNING = "Couldn't identify this directory to remember its model";
export const WRITE_WARNING = "Couldn't save the model for this directory";

export class DirectoryModelPreferenceService extends Context.Service<DirectoryModelPreferenceService>()(
  "pi-directory-models/preference/service/DirectoryModelPreferenceService",
  {
    make: Effect.fn("DirectoryModelPreferenceService.make")(function* (
      input: DirectoryModelSessionInput,
      warn: DirectoryModelWarn,
    ) {
      const pi = yield* PiApi;
      const store = yield* DirectoryModelStore;
      const gate = yield* Semaphore.make(1);
      let cachedIdentity: DirectoryIdentity | undefined;
      const warned = new Set<string>();

      const warnOnce = (key: string, message: string) =>
        Effect.sync(() => {
          if (warned.has(key)) return;
          warned.add(key);
          warn(message);
        });

      const recovered = <Value, E>(
        effect: Effect.Effect<Value, E>,
        key: string,
        message: string,
      ): Effect.Effect<Value | undefined> =>
        effect.pipe(Effect.catch(() => Effect.as(warnOnce(key, message), undefined)));

      const identity = Effect.gen(function* () {
        if (cachedIdentity) return cachedIdentity;
        const identified = yield* store.identify(input.cwd);
        cachedIdentity = identified;
        return identified;
      });

      const write = (identified: DirectoryIdentity, preference: DirectoryModelPreference) =>
        recovered(store.write(identified, preference), "write", WRITE_WARNING);

      const currentPreference = (canonicalCwd: string) =>
        Effect.suspend(() => {
          const selected = captureContextModel(input.models);
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
          const loaded = yield* store.read(identified).pipe(
            Effect.tapError((error) => warnOnce("read", readWarning(error.reason))),
            Effect.option,
          );
          if (Option.isNone(loaded)) return;
          const loadedPreference = loaded.value;
          if (!loadedPreference) {
            const current = yield* currentPreference(identified.canonicalCwd);
            if (current) yield* write(identified, current);
            return;
          }
          if (loadedPreference.invalidThinkingLevel)
            yield* warnOnce("read:thinkingLevel", THINKING_LEVEL_WARNING);
          const restored = yield* applyHostPreference(pi, input.models, loadedPreference).pipe(
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
