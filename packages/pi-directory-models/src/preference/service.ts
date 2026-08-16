import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { PiApi } from "pi-cosmic-core";
import {
  applyHostPreference,
  captureCurrentPreference,
  preferenceFromSelectedModel,
  type SelectedModel,
} from "../boundary/host-model.ts";
import type { ThinkingLevel } from "../config/schema.ts";
import { DirectoryModelStore, type DirectoryIdentity } from "../config/store.ts";

export interface DirectoryModelSessionInput {
  readonly ctx: ExtensionContext;
  readonly cwd: string;
  readonly fresh: boolean;
  readonly explicitModel: boolean;
}

export interface DirectoryModelPreferenceServiceContract {
  readonly initialize: Effect.Effect<void>;
  readonly rememberModel: (selected: SelectedModel) => Effect.Effect<void>;
  readonly rememberThinking: (selected: SelectedModel, level: ThinkingLevel) => Effect.Effect<void>;
}

export interface RestoreEventState {
  readonly active: boolean;
  readonly observedThinkingEvents: number;
  readonly pendingThinkingEvents: number;
}

export const INITIAL_RESTORE_EVENT_STATE: RestoreEventState = {
  active: false,
  observedThinkingEvents: 0,
  pendingThinkingEvents: 0,
};

export interface DirectoryModelPreferenceServiceOptions {
  readonly restoreEvents: MutableRef.MutableRef<RestoreEventState>;
  readonly warn: (message: string) => void;
}

const READ_WARNING = "Directory model preference is invalid; using Pi's current model.";
const IDENTIFY_WARNING = "Directory model preference is unavailable for this working directory.";
const WRITE_WARNING = "Unable to save the directory model preference.";

export class DirectoryModelPreferenceService extends Context.Service<
  DirectoryModelPreferenceService,
  DirectoryModelPreferenceServiceContract
>()("pi-directory-models/preference/service/DirectoryModelPreferenceService") {
  static readonly layer = (
    input: DirectoryModelSessionInput,
    options: DirectoryModelPreferenceServiceOptions,
  ) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const pi = yield* PiApi;
        const store = yield* DirectoryModelStore;
        const gate = yield* Semaphore.make(1);
        const identityRef = yield* Ref.make<DirectoryIdentity | undefined>(undefined);
        const warnedRef = yield* Ref.make<ReadonlySet<string>>(new Set());

        const warnOnce = (key: string, message: string) =>
          Ref.modify(warnedRef, (warned) => {
            if (warned.has(key)) return [false, warned] as const;
            const next = new Set(warned);
            next.add(key);
            return [true, next] as const;
          }).pipe(
            Effect.flatMap((shouldWarn) =>
              shouldWarn
                ? Effect.try({
                    try: () => options.warn(message),
                    catch: () => "notification-failed" as const,
                  }).pipe(Effect.catch(() => Effect.void))
                : Effect.void,
            ),
          );

        const identity = Effect.gen(function* () {
          const current = yield* Ref.get(identityRef);
          if (current) return current;
          const identified = yield* store.identify(input.cwd);
          yield* Ref.set(identityRef, identified);
          return identified;
        });

        const write = (
          identified: DirectoryIdentity,
          preference: Parameters<typeof store.write>[1],
        ) =>
          store
            .write(identified, preference)
            .pipe(Effect.catch(() => warnOnce("write", WRITE_WARNING)));

        const rememberSelected = (selected: SelectedModel, thinkingOverride?: ThinkingLevel) =>
          gate.withPermit(
            Effect.gen(function* () {
              const identified = yield* identity.pipe(
                Effect.catch(() =>
                  warnOnce("identify", IDENTIFY_WARNING).pipe(Effect.as(undefined)),
                ),
              );
              if (!identified) return;
              // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
              const preference = yield* preferenceFromSelectedModel(
                pi as ExtensionAPI,
                identified.canonicalCwd,
                selected,
                thinkingOverride,
              ).pipe(
                Effect.catch(() =>
                  warnOnce("current", "Unable to read Pi's current model preference.").pipe(
                    Effect.as(undefined),
                  ),
                ),
              );
              if (!preference) return;
              yield* write(identified, preference);
            }),
          );

        const initialize = gate.withPermit(
          Effect.gen(function* () {
            if (!input.fresh || input.explicitModel) return;
            const identified = yield* identity.pipe(
              Effect.catch(() => warnOnce("identify", IDENTIFY_WARNING).pipe(Effect.as(undefined))),
            );
            if (!identified) return;
            const loaded = yield* store.read(identified).pipe(
              Effect.matchEffect({
                onFailure: () =>
                  warnOnce("read", READ_WARNING).pipe(Effect.as({ _tag: "Failed" as const })),
                onSuccess: (preference) => Effect.succeed({ _tag: "Loaded" as const, preference }),
              }),
            );
            if (loaded._tag === "Failed") return;
            const loadedPreference = loaded.preference;
            if (!loadedPreference) {
              // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
              const current = yield* captureCurrentPreference(
                pi as ExtensionAPI,
                input.ctx,
                identified.canonicalCwd,
              ).pipe(
                Effect.catch(() =>
                  warnOnce("current", "Pi has no active model preference to remember.").pipe(
                    Effect.as(undefined),
                  ),
                ),
              );
              if (current) yield* write(identified, current);
              return;
            }
            // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
            const restored = yield* Effect.acquireUseRelease(
              Effect.sync(() =>
                MutableRef.set(options.restoreEvents, {
                  active: true,
                  observedThinkingEvents: 0,
                  pendingThinkingEvents: 0,
                }),
              ),
              () =>
                applyHostPreference(pi as ExtensionAPI, input.ctx, loadedPreference).pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      warnOnce(`restore:${error.operation}`, error.message).pipe(
                        Effect.as(undefined),
                      ),
                    onSuccess: (result) =>
                      Effect.sync(() => {
                        const events = MutableRef.get(options.restoreEvents);
                        MutableRef.set(options.restoreEvents, {
                          active: false,
                          observedThinkingEvents: 0,
                          pendingThinkingEvents: Math.max(
                            0,
                            result.thinkingEvents - events.observedThinkingEvents,
                          ),
                        });
                        return result.preference;
                      }),
                  }),
                ),
              () =>
                Effect.sync(() => {
                  const events = MutableRef.get(options.restoreEvents);
                  if (events.active)
                    MutableRef.set(options.restoreEvents, INITIAL_RESTORE_EVENT_STATE);
                }),
            );
            if (restored) yield* write(identified, restored);
          }),
        );

        return DirectoryModelPreferenceService.of({
          initialize,
          rememberModel: (selected) => rememberSelected(selected),
          rememberThinking: (selected, level) => rememberSelected(selected, level),
        });
      }),
    );
}
