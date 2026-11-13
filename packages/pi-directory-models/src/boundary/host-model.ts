import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import {
  decodeThinkingLevel,
  directoryModelPreference,
  type SavedDirectoryModelPreference,
  type ThinkingLevel,
} from "../config/schema.ts";

const SelectedModelSchema = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
});

export type SelectedModel = typeof SelectedModelSchema.Type;

class DirectoryModelHostError extends Schema.TaggedError<
  DirectoryModelHostError,
  { readonly brand: unique symbol }
>()("DirectoryModelHostError", { message: Schema.String }) {}

const hostError = (message: string) => () => DirectoryModelHostError.make({ message });

export const captureSelectedModel = decodeUnknownOrUndefined(SelectedModelSchema);

type HostModel = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;

/** The part of a session context the preference service may use; both reads can throw. */
export interface DirectoryModelHost {
  readonly currentModel: () => SelectedModel | undefined;
  readonly findModel: (provider: string, id: string) => HostModel | undefined;
}

export const directoryModelHost = (ctx: ExtensionContext): DirectoryModelHost => ({
  currentModel: () => captureSelectedModel(ctx.model),
  findModel: (provider, id) => ctx.modelRegistry.find(provider, id),
});

export function captureContextModel(host: DirectoryModelHost): SelectedModel | undefined {
  return invokeHostCallback(host.currentModel, undefined);
}

const thinkingReadError = hostError(
  "Couldn't read Pi's thinking level, so it wasn't saved for this directory\nPick it again with /thinking to save it",
);

const readThinkingLevel = (
  pi: ExtensionAPI,
): Effect.Effect<ThinkingLevel, DirectoryModelHostError> =>
  Effect.try(() => decodeThinkingLevel(pi.getThinkingLevel())).pipe(
    Effect.flatMap(Effect.fromNullishOr),
    Effect.mapError(thinkingReadError),
  );

export const preferenceFromSelectedModel = Effect.fn("DirectoryModelHost.fromSelected")(function* (
  pi: ExtensionAPI,
  canonicalCwd: string,
  selected: SelectedModel,
) {
  const thinkingLevel = yield* readThinkingLevel(pi);
  return directoryModelPreference(canonicalCwd, selected.provider, selected.id, thinkingLevel);
});

/** How the restore notice and warnings name a saved model: `provider/model`. */
export const savedModelLabel = (
  preference: Pick<SavedDirectoryModelPreference, "provider" | "model">,
) => `${preference.provider}/${preference.model}`;

export const applyHostPreference = Effect.fn("DirectoryModelHost.apply")(function* (
  pi: ExtensionAPI,
  host: DirectoryModelHost,
  preference: SavedDirectoryModelPreference,
) {
  const saved = savedModelLabel(preference);
  const current = yield* Effect.try({
    try: host.currentModel,
    catch: hostError(
      `Couldn't read Pi's current model, so ${saved}, saved for this directory, wasn't restored\nPick it with /model to use it`,
    ),
  });
  const switching = current?.provider !== preference.provider || current.id !== preference.model;
  if (switching) {
    const model = yield* Effect.try({
      try: () => host.findModel(preference.provider, preference.model),
      catch: hostError(
        `Couldn't read Pi's model list, so ${saved}, saved for this directory, wasn't restored\nPick it with /model to use it`,
      ),
    });
    if (!model)
      return yield* hostError(
        `${saved}, saved for this directory, isn't available\nPick another model with /model to replace it`,
      )();
    // Pi cannot cancel a model switch. Masking keeps an interrupted restore from abandoning a
    // switch that may still land; replacement therefore waits for Pi to settle it.
    const applied = yield* Effect.uninterruptible(
      Effect.tryPromise({
        try: () => pi.setModel(model),
        catch: hostError(
          `Couldn't switch to ${saved}, saved for this directory\nPick it with /model to try again`,
        ),
      }),
    );
    if (!applied)
      return yield* hostError(
        `${saved}, saved for this directory, isn't signed in\nRun /login ${preference.provider}, or pick another model with /model`,
      )();
  }
  const before = yield* Effect.option(readThinkingLevel(pi));
  const { thinkingLevel } = preference;
  if (thinkingLevel !== undefined)
    yield* Effect.try({
      try: () => pi.setThinkingLevel(thinkingLevel),
      catch: hostError(
        `Couldn't restore thinking level ${thinkingLevel}, saved for this directory\nSet it with /thinking ${thinkingLevel} to try again`,
      ),
    });
  const after = yield* readThinkingLevel(pi);
  return {
    preference: directoryModelPreference(
      preference.cwd,
      preference.provider,
      preference.model,
      after,
    ),
    /** Whether the restore changed Pi's model or thinking level, so it is worth a notice. */
    changed: switching || Option.getOrUndefined(before) !== after,
  };
});
