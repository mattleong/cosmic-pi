import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  cloneSessionProfileOverrideSeed,
  decodeSessionProfileOverrideSeed,
  type SessionProfileOverrideSeed,
} from "../profiles/session-overrides.ts";

const PROFILE_RELOAD_HANDOFF_KEY = Symbol.for("@cosmic-pi/pi-subagents/profile-reload-handoff/v1");
const MAX_PROFILE_RELOAD_SESSION_KEY_LENGTH = 1_024;

const isProfileReloadSessionKey = (value: string): boolean =>
  Predicate.isString(value) &&
  value.length >= 1 &&
  value.length <= MAX_PROFILE_RELOAD_SESSION_KEY_LENGTH;

interface ProfileReloadEnvelope {
  readonly version: 2;
  readonly sessionKey: string;
  readonly seed: SessionProfileOverrideSeed;
}

export interface ProfileReloadHandoff {
  readonly capture: (sessionKey: string) => SessionProfileOverrideSeed | undefined;
  readonly publish: (sessionKey: string, seed: SessionProfileOverrideSeed) => void;
  readonly clear: (sessionKey?: string) => void;
}

interface ProfileReloadGlobalState {
  [PROFILE_RELOAD_HANDOFF_KEY]?: unknown;
}

// SAFETY: This process-owned symbol slot is the sole property added to globalThis by this adapter.
const processState = (): typeof globalThis & ProfileReloadGlobalState =>
  globalThis as typeof globalThis & ProfileReloadGlobalState;

const ProfileReloadEnvelopeInputSchema = Schema.Struct({
  version: Schema.Literals([1, 2]),
  sessionKey: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_PROFILE_RELOAD_SESSION_KEY_LENGTH),
  ),
  seed: Schema.Unknown,
});
const exactDecodeOptions = { onExcessProperty: "error" as const };

const decodeEnvelope = <ValueInput>(value: ValueInput) => {
  try {
    return Schema.decodeUnknownOption(
      ProfileReloadEnvelopeInputSchema,
      exactDecodeOptions,
    )(value).pipe((decoded) => (decoded._tag === "Some" ? decoded.value : undefined));
  } catch {
    return undefined;
  }
};

const deleteEnvelope = (): void => {
  try {
    Reflect.deleteProperty(processState(), PROFILE_RELOAD_HANDOFF_KEY);
  } catch {
    // A hostile process-global descriptor must not escape the reload boundary.
  }
};

const readEnvelopeValue = ():
  | { readonly present: boolean; readonly value?: unknown }
  | undefined => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(processState(), PROFILE_RELOAD_HANDOFF_KEY);
    if (!descriptor) return { present: false };
    return "value" in descriptor ? { present: true, value: descriptor.value } : undefined;
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

const readEnvelope = (): ProfileReloadEnvelope | undefined => {
  const slot = readEnvelopeValue();
  if (!slot) {
    deleteEnvelope();
    return undefined;
  }
  if (!slot.present || slot.value === undefined) return undefined;
  try {
    const decoded = decodeEnvelope(slot.value);
    const seed = decoded ? decodeSessionProfileOverrideSeed(decoded.seed) : undefined;
    if (!decoded || !seed || (decoded.version === 2 && !seed.baseline)) {
      deleteEnvelope();
      return undefined;
    }
    return Object.freeze({
      version: 2,
      sessionKey: decoded.sessionKey,
      seed,
    });
  } catch {
    deleteEnvelope();
    return undefined;
  }
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
export const makeProfileReloadHandoff = (): ProfileReloadHandoff => ({
  capture: (sessionKey) => {
    try {
      if (!isProfileReloadSessionKey(sessionKey)) return undefined;
      const envelope = readEnvelope();
      return envelope?.sessionKey === sessionKey
        ? cloneSessionProfileOverrideSeed(envelope.seed)
        : undefined;
    } catch {
      return undefined;
    }
  },
  publish: (sessionKey, seed) => {
    try {
      if (!isProfileReloadSessionKey(sessionKey)) {
        deleteEnvelope();
        return;
      }
      const decodedSeed = decodeSessionProfileOverrideSeed(seed);
      if (!decodedSeed?.baseline) {
        deleteEnvelope();
        return;
      }
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
  clear: (sessionKey) => {
    try {
      if (sessionKey !== undefined && readEnvelope()?.sessionKey !== sessionKey) return;
      deleteEnvelope();
    } catch {
      // Reload cleanup is best effort and must not fail session lifecycle handling.
    }
  },
});
