// TTL bounding uses wall-clock time at this process-memory host boundary, not Effect-scheduled
// time; the handoff is synchronous globalThis state read from Pi session callbacks.
/**
 * Process-memory handoff for the deliberate `code_mode` deactivation intent, so a user's
 * choice survives Pi recreating the extension module on reload/new/resume/fork.
 *
 * The active `code_mode` deactivation flag normally lives only in the application closure
 * (see `application.ts`). Pi keeps a dynamically registered tool's activation across
 * re-registration but recreates the extension module on a session transition, discarding that
 * closure — so without a handoff a user who turned `code_mode` off would silently get it back
 * on the next reload. This mirrors the `pi-subagents` reload handoff: the old instance
 * publishes the observed intent on shutdown, and the fresh instance consumes it on start.
 *
 * Identity and leakage bounds:
 *
 * - The slot is keyed **only** by the stable Pi session id
 *   (`ctx.sessionManager.getSessionId()`). A different session has a different key, so the
 *   intent can never leak across sessions; a reload/resume keeps the same id and restores
 *   correctly, while a new or forked session gets a different id and starts at the default.
 * - When no stable session id can be read, nothing is published or captured and the flag
 *   simply resets to its default (activated) — the safe direction. There is deliberately no
 *   cwd (or other ambient-identity) fallback: a cwd key would let a genuinely different
 *   session in the same project inherit another session's intent.
 * - Entries are consumed (cleared) on capture and carry a bounded TTL, so the slot never
 *   accumulates across projects or long-lived processes.
 *
 * The slot is process memory only. Pi does not recreate the process on reload/new/resume/fork
 * (it re-instantiates extensions in the same process, exactly as the subagents reload handoff
 * relies on), so cross-process persistence is neither possible nor attempted here.
 */
import * as Predicate from "effect/Predicate";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { synchronousNow } from "pi-cosmic-core";

const HANDOFF_SLOT_KEY = Symbol.for("@cosmic-pi/pi-code-mode/code-mode-deactivation-handoff/v2");

/** TTL for session-id-keyed entries: the key itself prevents cross-session leakage. */
const SESSION_KEY_TTL_MS = 60 * 60 * 1_000;

/** The stable Pi session id used as the one handoff identity. */
export type CodeModeSessionKey = string;

const HandoffEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(2),
  key: Schema.String.check(Schema.isNonEmpty()),
  deactivated: Schema.Literal(true),
  expiresAt: Schema.Finite,
});
type HandoffEnvelope = typeof HandoffEnvelopeSchema.Type;

interface CodeModeHandoffGlobalState {
  [HANDOFF_SLOT_KEY]?: unknown;
}

// SAFETY: This process-owned symbol slot is the sole property added to globalThis by this adapter.
const processState = (): typeof globalThis & CodeModeHandoffGlobalState =>
  globalThis as typeof globalThis & CodeModeHandoffGlobalState;

const clearEnvelope = (): void => {
  try {
    Reflect.deleteProperty(processState(), HANDOFF_SLOT_KEY);
  } catch {
    // A malformed process slot must not escape this best-effort handoff boundary.
  }
};

const readEnvelope = (): HandoffEnvelope | undefined => {
  try {
    const value = processState()[HANDOFF_SLOT_KEY];
    const decoded = Schema.decodeUnknownOption(HandoffEnvelopeSchema)(value);
    if (Option.isNone(decoded) || synchronousNow() > decoded.value.expiresAt) {
      if (value !== undefined) clearEnvelope();
      return undefined;
    }
    return decoded.value;
  } catch {
    clearEnvelope();
    return undefined;
  }
};

/**
 * Resolve the stable-identity key for the deactivation handoff: the Pi session id, or
 * undefined when the host does not expose one — in which case the caller preserves nothing
 * and the flag resets to its default (activated). There is deliberately no cwd fallback.
 */
export const codeModeSessionKey = (ctx: ExtensionContext): CodeModeSessionKey | undefined => {
  try {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (Predicate.isString(sessionId) && sessionId.length > 0) {
      return sessionId;
    }
  } catch {
    // No stable identity available.
  }
  return undefined;
};

/**
 * Consumes any published intent for `key` and clears the slot. Returns undefined when this
 * process has no matching unexpired entry.
 */
export const captureCodeModeDeactivation = (
  key: CodeModeSessionKey | undefined,
): true | undefined => {
  if (key === undefined) return undefined;
  const envelope = readEnvelope();
  if (envelope === undefined || envelope.key !== key) return undefined;
  clearEnvelope();
  return envelope.deactivated;
};

/** Publishes a deliberate deactivation for a recreated extension instance to consume. */
export const publishCodeModeDeactivation = (key: CodeModeSessionKey | undefined): void => {
  if (key === undefined) return;
  let envelope: HandoffEnvelope;
  try {
    envelope = Object.freeze({
      version: 2,
      key,
      deactivated: true,
      expiresAt: synchronousNow() + SESSION_KEY_TTL_MS,
    });
  } catch {
    return;
  }

  const writeEnvelope = (): boolean => {
    try {
      return Reflect.set(processState(), HANDOFF_SLOT_KEY, envelope);
    } catch {
      return false;
    }
  };
  if (writeEnvelope()) return;

  // A configurable hostile or stale descriptor can reject the first write. Remove it and make
  // one last attempt, but never let this optional handoff block lifecycle teardown.
  clearEnvelope();
  writeEnvelope();
};
