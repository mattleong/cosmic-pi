import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { invokeHostCallback } from "pi-cosmic-core";
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

/** A present same-session seed cannot be replaced by disk defaults during reload. */
export class IncompatibleProfileReloadHandoffError extends Schema.TaggedError<IncompatibleProfileReloadHandoffError>()(
  "IncompatibleProfileReloadHandoffError",
  { message: Schema.String },
) {}

interface ProfileReloadGlobalState {
  [PROFILE_RELOAD_HANDOFF_KEY]?: unknown;
}

// SAFETY: This process-owned symbol slot is the sole property added to globalThis by this adapter.
const processState = (): typeof globalThis & ProfileReloadGlobalState =>
  globalThis as typeof globalThis & ProfileReloadGlobalState;

const decodeEnvelope = Schema.decodeUnknownOption(
  Schema.Struct({
    version: Schema.Literals([1, 2]),
    sessionKey: ProfileReloadSessionKeySchema,
    seed: Schema.Unknown,
  }),
  { onExcessProperty: "error" },
);

const deleteEnvelope = (): void => {
  try {
    Reflect.deleteProperty(processState(), PROFILE_RELOAD_HANDOFF_KEY);
  } catch {
    // A hostile process-global descriptor must not escape the reload boundary.
  }
};

/** The slot's data value, if any; an accessor or an unreadable slot reads as undefined. */
const readEnvelopeValue = (): { readonly value?: unknown } | undefined => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(processState(), PROFILE_RELOAD_HANDOFF_KEY);
    if (!descriptor) return {};
    return "value" in descriptor ? { value: descriptor.value } : undefined;
  } catch {
    return undefined;
  }
};

const writeEnvelope = (envelope: ProfileReloadEnvelope): void => {
  try {
    Reflect.defineProperty(processState(), PROFILE_RELOAD_HANDOFF_KEY, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: envelope,
    });
  } catch {
    // Publication is best effort across independently loaded extension modules.
  }
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
  // The slot is shared by independently loaded modules, so a hostile value cannot escape decoding.
  const decoded = invokeHostCallback(
    () => Option.getOrUndefined(decodeEnvelope(slot.value)),
    undefined,
  );
  if (decoded) {
    const seed = decodeSessionProfileOverrideSeed(decoded.seed);
    if (seed && (decoded.version === 1 || seed.baseline))
      return { sessionKey: decoded.sessionKey, seed };
    if (decoded.sessionKey === sessionKey)
      throw new IncompatibleProfileReloadHandoffError({
        message:
          "Subagents cannot restore this session's profile settings. Start a fresh Pi session to recover.",
      });
  }
  deleteEnvelope();
  return undefined;
};

/**
 * Returns a process-local identity that remains stable while Pi reloads one session runtime.
 * Session replacement creates a different identity and is also cleared explicitly by lifecycle wiring.
 */
export const profileReloadSessionKey = (ctx: ExtensionContext): string | undefined => {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    return isProfileReloadSessionKey(sessionId) ? sessionId : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Bridges a frozen override seed between the old and new extension module instances during `/reload`.
 * The slot is process-memory only, bound to one Pi session identity, and consumed after activation.
 */
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
    } catch {
      // Reload publication is best effort and must not fail session shutdown.
    }
  },
  clear: (sessionKey?: string): void => {
    try {
      if (sessionKey !== undefined && readEnvelope(sessionKey)?.sessionKey !== sessionKey) return;
      deleteEnvelope();
    } catch {
      // Reload cleanup is best effort and must not fail session lifecycle handling.
    }
  },
};
