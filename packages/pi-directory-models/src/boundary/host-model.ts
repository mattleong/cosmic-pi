import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  THINKING_LEVELS,
  makeDirectoryModelPreference,
  type DirectoryModelPreference,
  type ThinkingLevel,
} from "../config/schema.ts";

export interface SelectedModel {
  readonly provider: string;
  readonly id: string;
}

export class DirectoryModelHostError extends Schema.TaggedErrorClass<DirectoryModelHostError>()(
  "DirectoryModelHostError",
  { operation: Schema.String, message: Schema.String },
) {}

const hostError = (operation: string, message: string) => () =>
  new DirectoryModelHostError({ operation, message });

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.some((level) => level === value);
}

export function captureSelectedModel(value: unknown): SelectedModel | undefined {
  try {
    if (!value || typeof value !== "object") return undefined;
    const candidate = value as { provider?: unknown; id?: unknown };
    if (typeof candidate.provider !== "string" || typeof candidate.id !== "string")
      return undefined;
    return { provider: candidate.provider, id: candidate.id };
  } catch {
    return undefined;
  }
}

export function captureContextModel(ctx: ExtensionContext): SelectedModel | undefined {
  try {
    return captureSelectedModel(ctx.model);
  } catch {
    return undefined;
  }
}

export const preferenceFromSelectedModel = Effect.fn("DirectoryModelHost.fromSelected")(function* (
  pi: ExtensionAPI,
  canonicalCwd: string,
  selected: SelectedModel,
  thinkingOverride?: ThinkingLevel,
) {
  const thinkingLevel = yield* Effect.try({
    try: () => {
      if (thinkingOverride) return thinkingOverride;
      const fromApi = pi.getThinkingLevel();
      if (isThinkingLevel(fromApi)) return fromApi;
      throw new Error("invalid thinking level");
    },
    catch: hostError("read", "Unable to read Pi's current thinking level."),
  });
  return makeDirectoryModelPreference(canonicalCwd, selected.provider, selected.id, thinkingLevel);
});

export const captureCurrentPreference = Effect.fn("DirectoryModelHost.captureCurrent")(function* (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  canonicalCwd: string,
) {
  const current = captureContextModel(ctx);
  if (!current) return yield* hostError("read", "Pi has no active model to remember.")();
  return yield* preferenceFromSelectedModel(pi, canonicalCwd, current);
});

const readThinkingLevel = (pi: ExtensionAPI) =>
  Effect.try({
    try: () => {
      const level = pi.getThinkingLevel();
      if (isThinkingLevel(level)) return level;
      throw new Error("invalid thinking level");
    },
    catch: hostError("thinking", "Unable to read Pi's thinking level."),
  });

export const applyHostPreference = Effect.fn("DirectoryModelHost.apply")(function* (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  preference: DirectoryModelPreference,
) {
  let previousThinking = yield* readThinkingLevel(pi);
  let thinkingEvents = 0;
  const current = yield* Effect.try({
    try: () => captureSelectedModel(ctx.model),
    catch: hostError("read", "Unable to inspect Pi's current model."),
  });
  if (current?.provider !== preference.provider || current.id !== preference.model) {
    const model = yield* Effect.try({
      try: () => ctx.modelRegistry.find(preference.provider, preference.model),
      catch: hostError("find", "Unable to inspect Pi's model registry."),
    });
    if (!model)
      return yield* hostError("find", "The remembered directory model is not available.")();
    const applied = yield* Effect.tryPromise({
      try: () => pi.setModel(model),
      catch: hostError("set", "Unable to select the remembered directory model."),
    });
    if (!applied)
      return yield* hostError(
        "auth",
        "The remembered directory model has no configured authentication.",
      )();
    const modelThinking = yield* readThinkingLevel(pi);
    if (modelThinking !== previousThinking) thinkingEvents++;
    previousThinking = modelThinking;
  }
  yield* Effect.try({
    try: () => pi.setThinkingLevel(preference.thinkingLevel),
    catch: hostError("thinking", "Unable to restore the remembered thinking level."),
  });
  const effectiveThinking = yield* readThinkingLevel(pi);
  if (effectiveThinking !== previousThinking) thinkingEvents++;
  return {
    preference: makeDirectoryModelPreference(
      preference.cwd,
      preference.provider,
      preference.model,
      effectiveThinking,
    ),
    thinkingEvents,
  };
});
