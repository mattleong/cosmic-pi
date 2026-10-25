import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import * as Arr from "effect/Array";
import { PROFILE_IDS } from "../profiles/model.ts";
import {
  decodeSessionProfileOverrideSeed,
  decodeSessionProfileRestore,
  type SessionProfileOverrideSeed,
  type SessionProfileRestore,
  type SessionProfileRestoreResets,
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

// An envelope may come from an earlier module instance, so it is decoded as unknown input. Its
// session key decodes alone, so a session recognizes its own envelope even in another shape.
const decodeEnvelopeSessionKey = decodeUnknownOrUndefined(
  Schema.Struct({ sessionKey: ProfileReloadSessionKeySchema }),
);
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

/** The handoff slot's own value, read or written as is. */
interface EnvelopeSlot {
  readonly value?: unknown;
}

const readEnvelopeValue = (): EnvelopeSlot | undefined => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, PROFILE_RELOAD_HANDOFF_KEY);
    if (!descriptor) return {};
    return "value" in descriptor ? { value: descriptor.value } : undefined;
  } catch {
    return undefined;
  }
};

const writeEnvelopeValue = (slot: EnvelopeSlot): void => {
  try {
    Reflect.defineProperty(globalThis, PROFILE_RELOAD_HANDOFF_KEY, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: slot.value,
    });
  } catch {}
};

export const profileReloadSessionKey = (ctx: ExtensionContext): string | undefined => {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    return isProfileReloadSessionKey(sessionId) ? sessionId : undefined;
  } catch {
    return undefined;
  }
};

/** A session's captured handoff and what still decodes from it. */
export interface ProfileReloadCapture {
  readonly restore: SessionProfileRestore;
  /**
   * Puts the captured handoff back unchanged, for a runtime that never applied it, so the next
   * reload decodes, fails closed, and reports exactly as this one would have.
   */
  readonly retain: () => void;
}

export const profileReloadHandoff = {
  /**
   * Restores what still decodes from this session's handoff. Reading clears any handoff, so one
   * that no longer decodes affects only the reload that read it unless it is retained.
   */
  capture: (sessionKey: string): ProfileReloadCapture | undefined => {
    const slot = readEnvelopeValue();
    deleteEnvelope();
    if (
      slot?.value === undefined ||
      !isProfileReloadSessionKey(sessionKey) ||
      decodeEnvelopeSessionKey(slot.value)?.sessionKey !== sessionKey
    )
      return undefined;
    return {
      restore: decodeSessionProfileRestore(decodeEnvelope(slot.value)?.seed),
      retain: () => writeEnvelopeValue(slot),
    };
  },
  publish: (sessionKey: string, seed: SessionProfileOverrideSeed): void => {
    try {
      if (!isProfileReloadSessionKey(sessionKey)) {
        deleteEnvelope();
        return;
      }
      const decodedSeed = decodeSessionProfileOverrideSeed(seed);
      if (!decodedSeed?.baseline) return;
      writeEnvelopeValue({
        value: Object.freeze({
          version: 2,
          sessionKey,
          seed: decodedSeed,
        } satisfies ProfileReloadEnvelope),
      });
    } catch {}
  },
  clear: deleteEnvelope,
};

const listed = (items: ReadonlyArray<string>): string =>
  Arr.isReadonlyArrayNonEmpty(items) && items.length > 1
    ? `${Arr.join(Arr.dropRight(items, 1), ", ")} and ${Arr.lastNonEmpty(items)}`
    : Arr.join(items, "");

/** The user's notice naming the session settings a reload couldn't keep. */
export const sessionRestoreNotice = (resets: SessionProfileRestoreResets): string => {
  if (resets.unreadable)
    return "Subagents couldn't read this session's settings after reload, so they use the saved configuration with writer routes read-only and nesting limits at their minimum.";
  const reset = [
    ...(resets.routes.length === PROFILE_IDS.length
      ? ["profile routes"]
      : Arr.map(resets.routes, (profile) => `${profile} route`)),
    ...(resets.profileSet ? ["profile set"] : []),
    ...(resets.delegation ? ["delegation mode"] : []),
  ];
  return Arr.join(
    [
      ...(reset.length > 0
        ? [`Subagents reset this session's ${listed(reset)} to the saved configuration.`]
        : []),
      ...(resets.readOnly.length > 0
        ? [
            `The ${listed(resets.readOnly)} ${resets.readOnly.length === 1 ? "route stays" : "routes stay"} read-only.`,
          ]
        : []),
      ...(resets.nesting
        ? [
            "Invalid session nesting limits were brought within their bounds or set to their minimum.",
          ]
        : []),
    ],
    " ",
  );
};
