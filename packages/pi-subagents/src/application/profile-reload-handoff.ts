import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  cloneSessionProfileOverrideSeed,
  decodeSessionProfileOverrideSeed,
  type SessionProfileOverrideSeed,
} from "../profiles/session-overrides.ts";

const PROFILE_RELOAD_HANDOFF_KEY = Symbol.for("@cosmic-pi/pi-subagents/profile-reload-handoff/v1");

interface ProfileReloadEnvelope {
  readonly version: 1;
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
  version: Schema.Literal(1),
  sessionKey: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
  seed: Schema.Unknown,
});
const exactDecodeOptions = { onExcessProperty: "error" as const };

const readEnvelope = (): ProfileReloadEnvelope | undefined => {
  const state = processState();
  const value = state[PROFILE_RELOAD_HANDOFF_KEY];
  if (value === undefined) return undefined;
  const decoded = Schema.decodeUnknownOption(
    ProfileReloadEnvelopeInputSchema,
    exactDecodeOptions,
  )(value);
  const seed = Option.isSome(decoded)
    ? decodeSessionProfileOverrideSeed(decoded.value.seed)
    : undefined;
  if (Option.isNone(decoded) || !seed) {
    delete state[PROFILE_RELOAD_HANDOFF_KEY];
    return undefined;
  }
  return Object.freeze({
    version: 1,
    sessionKey: decoded.value.sessionKey,
    seed,
  });
};

/**
 * Returns a process-local identity that remains stable while Pi reloads one session runtime.
 * Session replacement creates a different identity and is also cleared explicitly by lifecycle wiring.
 */
export const profileReloadSessionKey = (ctx: ExtensionContext): string | undefined => {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    return sessionId.length > 0 ? sessionId : undefined;
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
    const envelope = readEnvelope();
    return envelope?.sessionKey === sessionKey
      ? cloneSessionProfileOverrideSeed(envelope.seed)
      : undefined;
  },
  publish: (sessionKey, seed) => {
    processState()[PROFILE_RELOAD_HANDOFF_KEY] = Object.freeze({
      version: 1,
      sessionKey,
      seed: cloneSessionProfileOverrideSeed(seed),
    } satisfies ProfileReloadEnvelope);
  },
  clear: (sessionKey) => {
    if (sessionKey !== undefined && readEnvelope()?.sessionKey !== sessionKey) return;
    delete processState()[PROFILE_RELOAD_HANDOFF_KEY];
  },
});
