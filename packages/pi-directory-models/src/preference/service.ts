import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { PiApi } from "pi-cosmic-core/runtime/pi-api";
import { formatDisplayPath } from "pi-cosmic-core/platform/paths";
import {
  applyHostPreference,
  captureContextModel,
  preferenceFromSelectedModel,
  savedModelLabel,
  type DirectoryModelHost,
} from "../boundary/host-model.ts";
import {
  completeSavedPreference,
  equivalentPreference,
  type DirectoryModelPreference,
} from "../config/schema.ts";
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

export type DirectoryModelNotify = (message: string, level: "info" | "warning") => void;

/** The preference file as the user would find it, with the home directory as `~`. */
const shownPath = (identified: DirectoryIdentity) =>
  formatDisplayPath(identified.preferencePath, identified.canonicalCwd);

// Choosing a model or thinking level rewrites the file, so that is every read warning's recovery.
const readWarning = (reason: DirectoryModelStoreError["reason"], identified: DirectoryIdentity) =>
  Match.value(reason).pipe(
    Match.when(
      "invalid",
      () =>
        `The saved model for this directory is invalid, so Pi kept its current model\nPick a model with /model to replace it, or fix ${shownPath(identified)}`,
    ),
    Match.when(
      "foreign",
      () =>
        `The saved model file for this directory names another directory, so Pi kept its current model\nPick a model with /model to replace it, or check ${shownPath(identified)}`,
    ),
    Match.orElse(
      () =>
        `Couldn't read the saved model for this directory, so Pi kept its current model\nCheck that ${shownPath(identified)} is readable`,
    ),
  );
const THINKING_LEVEL_WARNING =
  "The thinking level saved for this directory is invalid, so Pi kept its current level\nPick one with /thinking to replace it";
const IDENTIFY_WARNING =
  "Couldn't resolve this directory's path, so its model isn't remembered in this session";
export const WRITE_WARNING = "Couldn't save the model for this directory";
const writeWarning = (identified: DirectoryIdentity) =>
  `${WRITE_WARNING}\nCheck that ${shownPath(identified)} can be written`;

/** The muted notice after a restore changed the session: what is in use, and why. */
const restoredNotice = (preference: DirectoryModelPreference) =>
  `Using ${savedModelLabel(preference)} · thinking ${preference.thinkingLevel}, saved for this directory`;

export class DirectoryModelPreferenceService extends Context.Service<DirectoryModelPreferenceService>()(
  "pi-directory-models/preference/service/DirectoryModelPreferenceService",
  {
    make: Effect.fn("DirectoryModelPreferenceService.make")(function* (
      input: DirectoryModelSessionInput,
      notify: DirectoryModelNotify,
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
          notify(message, "warning");
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

      // Another Pi process may have saved a different preference, so only a stored document that
      // already holds this capture skips the locked write; an unreadable one is rewritten.
      const write = (identified: DirectoryIdentity, preference: DirectoryModelPreference) =>
        store.read(identified).pipe(
          Effect.map((saved) => saved && completeSavedPreference(saved)),
          Effect.orElseSucceed(() => undefined),
          Effect.flatMap((stored) =>
            stored && equivalentPreference(stored, preference)
              ? Effect.void
              : recovered(store.write(identified, preference), "write", writeWarning(identified)),
          ),
        );

      const currentPreference = (canonicalCwd: string) =>
        Effect.suspend(() => {
          const selected = captureContextModel(input.models);
          if (!selected) return Effect.undefined;
          return recovered(
            preferenceFromSelectedModel(pi, canonicalCwd, selected),
            "current",
            "Couldn't read Pi's current model, so it wasn't saved for this directory",
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
            Effect.tapError((error) => warnOnce("read", readWarning(error.reason, identified))),
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
          if (!restored) return;
          if (restored.changed)
            yield* Effect.sync(() => notify(restoredNotice(restored.preference), "info"));
          yield* write(identified, restored.preference);
        }),
      );

      return { initialize, remember };
    }),
  },
) {}
