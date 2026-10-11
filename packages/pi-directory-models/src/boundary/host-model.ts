import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, invokeHostCallback } from "pi-cosmic-core";
import {
  makeDirectoryModelPreference,
  type DirectoryModelPreference,
  ThinkingLevelSchema,
  type ThinkingLevel,
} from "../config/schema.ts";

const SelectedModelSchema = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
});
const decodeSelectedModel = Schema.decodeUnknownOption(SelectedModelSchema);
const decodeThinkingLevel = Schema.decodeUnknownOption(ThinkingLevelSchema);

export type SelectedModel = typeof SelectedModelSchema.Type;

export class DirectoryModelHostError extends Schema.TaggedError<DirectoryModelHostError>()(
  "DirectoryModelHostError",
  { operation: Schema.String, message: Schema.String },
) {}

const hostError = (operation: string, message: string) => () =>
  new DirectoryModelHostError({ operation, message });

export function captureThinkingLevel<ValueInput>(value: ValueInput): ThinkingLevel | undefined {
  return decodeUnknownOrUndefined(ThinkingLevelSchema, value);
}

export function captureSelectedModel<ValueInput>(value: ValueInput): SelectedModel | undefined {
  return decodeUnknownOrUndefined(SelectedModelSchema, value);
}

export function captureContextModel(ctx: ExtensionContext): SelectedModel | undefined {
  return invokeHostCallback(() => captureSelectedModel(ctx.model), undefined);
}

const thinkingReadError = hostError("thinking", "Couldn't read Pi's thinking level");

const readThinkingLevel = (
  pi: ExtensionAPI,
): Effect.Effect<ThinkingLevel, DirectoryModelHostError> =>
  Effect.try({
    try: () => decodeThinkingLevel(pi.getThinkingLevel()),
    catch: thinkingReadError,
  }).pipe(Effect.flatMap(Effect.fromOption(thinkingReadError)));

export const preferenceFromSelectedModel = Effect.fn("DirectoryModelHost.fromSelected")(function* (
  pi: ExtensionAPI,
  canonicalCwd: string,
  selected: SelectedModel,
) {
  const thinkingLevel = yield* readThinkingLevel(pi);
  return makeDirectoryModelPreference(canonicalCwd, selected.provider, selected.id, thinkingLevel);
});

export const applyHostPreference = Effect.fn("DirectoryModelHost.apply")(function* (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  preference: DirectoryModelPreference,
) {
  const current = yield* Effect.try({
    try: () => Option.getOrUndefined(decodeSelectedModel(ctx.model)),
    catch: hostError("read", "Couldn't read Pi's current model"),
  });
  if (current?.provider !== preference.provider || current.id !== preference.model) {
    const model = yield* Effect.try({
      try: () => ctx.modelRegistry.find(preference.provider, preference.model),
      catch: hostError("find", "Couldn't read Pi's model list"),
    });
    if (!model)
      return yield* hostError("find", "The model saved for this directory isn't available")();
    const applied = yield* Effect.uninterruptible(
      Effect.tryPromise({
        try: () => pi.setModel(model),
        catch: hostError("set", "Couldn't switch to the model saved for this directory"),
      }),
    );
    if (!applied)
      return yield* hostError("auth", "The model saved for this directory isn't signed in")();
  }
  yield* Effect.try({
    try: () => pi.setThinkingLevel(preference.thinkingLevel),
    catch: hostError("thinking", "Couldn't restore the thinking level saved for this directory"),
  });
  return { ...preference, thinkingLevel: yield* readThinkingLevel(pi) };
});
