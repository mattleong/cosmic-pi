import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import {
  cloneSessionProfileOverrideSeed,
  decodeSessionProfileOverrideSeed,
  type SessionProfileOverrideSeed,
} from "../profiles/session-overrides.ts";

const PROFILE_RELOAD_HANDOFF_KEY = Symbol.for("@cosmic-pi/pi-subagents/profile-reload-handoff/v1");

const ProfileReloadSessionKeySchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_024),
);
const isProfileReloadSessionKey = Schema.is(ProfileReloadSessionKeySchema);

interface ProfileReloadEnvelope {
  readonly version: 2;
  readonly sessionKey: string;
  readonly seed: SessionProfileOverrideSeed;
}

export class IncompatibleProfileReloadHandoffError extends Schema.TaggedError<
  IncompatibleProfileReloadHandoffError,
  { readonly brand: unique symbol }
>()("IncompatibleProfileReloadHandoffError", { message: Schema.String }) {}

// An envelope may come from an earlier module instance, so it is decoded as unknown input.
const decodeEnvelope = decodeUnknownOrUndefined(
  Schema.Struct({
    version: Schema.Literal(2),
    sessionKey: ProfileReloadSessionKeySchema,
    seed: Schema.Unknown,
  }),
  { onExcessProperty: "error" },
);

const deleteEnvelope = (): void => {
  try {
    Reflect.deleteProperty(globalThis, PROFILE_RELOAD_HANDOFF_KEY);
  } catch {}
};

const readEnvelopeValue = (): { readonly value?: unknown } | undefined => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, PROFILE_RELOAD_HANDOFF_KEY);
    if (!descriptor) return {};
    return "value" in descriptor ? { value: descriptor.value } : undefined;
  } catch {
    return undefined;
  }
};

const writeEnvelope = (envelope: ProfileReloadEnvelope): void => {
  try {
    Reflect.defineProperty(globalThis, PROFILE_RELOAD_HANDOFF_KEY, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: envelope,
    });
  } catch {}
};

const readEnvelope = (
  sessionKey?: string,
): Pick<ProfileReloadEnvelope, "sessionKey" | "seed"> | undefined => {
  const slot = readEnvelopeValue();
  if (!slot) {
    deleteEnvelope();
    return undefined;
  }
  if (slot.value === undefined) return undefined;
  const decoded = decodeEnvelope(slot.value);
  if (decoded) {
    const seed = decodeSessionProfileOverrideSeed(decoded.seed);
    if (seed?.baseline) return { sessionKey: decoded.sessionKey, seed };
    if (decoded.sessionKey === sessionKey)
      throw IncompatibleProfileReloadHandoffError.make({
        message:
          "Subagents cannot restore this session's profile settings. Start a fresh Pi session to recover.",
      });
  }
  deleteEnvelope();
  return undefined;
};

export const profileReloadSessionKey = (ctx: ExtensionContext): string | undefined => {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    return isProfileReloadSessionKey(sessionId) ? sessionId : undefined;
  } catch {
    return undefined;
  }
};

export const profileReloadHandoff = {
  capture: (sessionKey: string): SessionProfileOverrideSeed | undefined => {
    if (!isProfileReloadSessionKey(sessionKey)) return undefined;
    const envelope = readEnvelope(sessionKey);
    return envelope?.sessionKey === sessionKey
      ? cloneSessionProfileOverrideSeed(envelope.seed)
      : undefined;
  },
  publish: (sessionKey: string, seed: SessionProfileOverrideSeed): void => {
    try {
      if (!isProfileReloadSessionKey(sessionKey)) {
        deleteEnvelope();
        return;
      }
      const decodedSeed = decodeSessionProfileOverrideSeed(seed);
      if (!decodedSeed?.baseline) return;
      writeEnvelope(
        Object.freeze({
          version: 2,
          sessionKey,
          seed: decodedSeed,
        } satisfies ProfileReloadEnvelope),
      );
    } catch {}
  },
  clear: (sessionKey?: string): void => {
    try {
      if (sessionKey !== undefined && readEnvelope(sessionKey)?.sessionKey !== sessionKey) return;
      deleteEnvelope();
    } catch {}
  },
};
