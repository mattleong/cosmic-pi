import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { snapshotData } from "./safe-data.ts";

export class AdvisorHostContextError extends Schema.TaggedErrorClass<AdvisorHostContextError>()(
  "AdvisorHostContextError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface AdvisorAbortRegistration {
  readonly aborted: boolean;
  readonly remove: () => void;
}

export interface AdvisorAbortInput {
  readonly signal: AbortSignal | undefined;
  readonly signalAborted: boolean;
}

export interface AdvisorSessionInput extends AdvisorAbortInput {
  readonly ctx: ExtensionContext;
  readonly cwd: string;
  readonly modelRegistry: ExtensionContext["modelRegistry"];
  readonly projectTrusted: boolean;
}

export type AdvisorAbortRegistrationResult =
  | { readonly ok: true; readonly registration: AdvisorAbortRegistration }
  | { readonly ok: false; readonly error: AdvisorHostContextError };

export type AdvisorSessionInputResult =
  | { readonly ok: true; readonly input: AdvisorSessionInput }
  | { readonly ok: false; readonly error: AdvisorHostContextError };

export type AdvisorAbortInputResult =
  | { readonly ok: true; readonly input: AdvisorAbortInput }
  | { readonly ok: false; readonly error: AdvisorHostContextError };

export type AdvisorHostReadResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: AdvisorHostContextError };

export type AdvisorSessionBranch = ReturnType<
  NonNullable<ExtensionContext["sessionManager"]["getBranch"]>
>;
export type AdvisorContextEntries = ReturnType<
  ExtensionContext["sessionManager"]["buildContextEntries"]
>;

const hostContextError = (operation: string, message: string) =>
  new AdvisorHostContextError({ operation, message });

const readHostContext = <A>(
  operation: string,
  message: string,
  read: () => A,
): AdvisorHostReadResult<A> => {
  try {
    return { ok: true, value: read() };
  } catch {
    return { ok: false, error: hostContextError(operation, message) };
  }
};

const materializeHostArray = <A>(value: unknown): A[] => {
  if (!Array.isArray(value)) throw new TypeError("Host session value is not an array.");
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !lengthDescriptor ||
    !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  )
    throw new TypeError("Host session array length is invalid.");
  const output: A[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor))
      throw new TypeError("Host session array entry is invalid.");
    const snapshot = snapshotData(descriptor.value);
    if (snapshot === undefined || snapshot === null || typeof snapshot !== "object")
      throw new TypeError("Host session array entry is not data.");
    output.push(snapshot as A);
  }
  return output;
};

/** Contains hostile AbortSignal getters and methods behind one exact-once ownership adapter. */
export function registerAdvisorAbortListenerAtHostBoundary(
  input: Pick<AdvisorSessionInput, "signal" | "signalAborted">,
  listener: () => void,
): AdvisorAbortRegistrationResult {
  const signal = input.signal;
  let removalNeeded = false;
  let delivered = false;
  const deliver = () => {
    if (delivered) return;
    delivered = true;
    try {
      listener();
    } catch {
      // Native host callbacks cannot carry an Effect failure; admission remains no-throw.
    }
  };
  const remove = () => {
    if (!signal || !removalNeeded) return;
    removalNeeded = false;
    try {
      signal.removeEventListener("abort", deliver);
    } catch {
      // Cleanup is idempotent and no-fail at the host boundary.
    }
  };

  try {
    if (!signal) return { ok: true, registration: { aborted: false, remove } };
    // Assume ownership before invoking the hostile method: an implementation may register and
    // then throw, in which case the failure path must still attempt removal.
    removalNeeded = true;
    signal.addEventListener("abort", deliver, { once: true });
    // Re-read after registration to close the capture-to-listener race. Delivery is exact-once
    // when the native listener fired synchronously during registration.
    const aborted = input.signalAborted || signal.aborted === true;
    if (aborted) deliver();
    return { ok: true, registration: { aborted, remove } };
  } catch {
    remove();
    return {
      ok: false,
      error: hostContextError(
        "abort-listener",
        "Advisor could not observe host cancellation safely.",
      ),
    };
  }
}

export const registerAdvisorAbortListenerEffect = (
  input: Pick<AdvisorSessionInput, "signal" | "signalAborted">,
  listener: () => void,
): Effect.Effect<AdvisorAbortRegistration, AdvisorHostContextError> =>
  Effect.suspend(() => {
    const result = registerAdvisorAbortListenerAtHostBoundary(input, listener);
    return result.ok ? Effect.succeed(result.registration) : Effect.fail(result.error);
  });

/** Materializes guarded Pi session getters exactly once before runtime creation. */
export function captureAdvisorSessionInputAtHostBoundary(
  ctx: ExtensionContext,
): AdvisorSessionInputResult {
  try {
    const cwd = ctx.cwd;
    if (typeof cwd !== "string") throw new TypeError("Host CWD is invalid.");
    const modelRegistry = ctx.modelRegistry;
    if (modelRegistry === null || typeof modelRegistry !== "object")
      throw new TypeError("Host model registry is invalid.");
    const signal = ctx.signal;
    if (signal !== undefined && (signal === null || typeof signal !== "object"))
      throw new TypeError("Host signal is invalid.");
    const signalAborted = signal?.aborted === true;
    const isProjectTrusted = ctx.isProjectTrusted;
    const projectTrusted =
      typeof isProjectTrusted === "function" && isProjectTrusted.call(ctx) === true;
    return {
      ok: true,
      input: { ctx, cwd, modelRegistry, projectTrusted, signal, signalAborted },
    };
  } catch {
    return {
      ok: false,
      error: hostContextError(
        "session-input",
        "Advisor could not capture the host session safely.",
      ),
    };
  }
}

export const captureAdvisorSessionInputEffect = (
  ctx: ExtensionContext,
): Effect.Effect<AdvisorSessionInput, AdvisorHostContextError> =>
  Effect.suspend(() => {
    const result = captureAdvisorSessionInputAtHostBoundary(ctx);
    return result.ok ? Effect.succeed(result.input) : Effect.fail(result.error);
  });

/** Captures the current Pi run signal; unlike session metadata this capability is turn-dynamic. */
export function captureAdvisorAbortInputAtHostBoundary(
  ctx: Pick<ExtensionContext, "signal">,
): AdvisorAbortInputResult {
  try {
    const signal = ctx.signal;
    if (signal !== undefined && (signal === null || typeof signal !== "object"))
      throw new TypeError("Host signal is invalid.");
    return {
      ok: true,
      input: { signal, signalAborted: signal?.aborted === true },
    };
  } catch {
    return {
      ok: false,
      error: hostContextError(
        "abort-input",
        "Advisor could not capture the current host cancellation signal safely.",
      ),
    };
  }
}

/** Dynamic session reads stay narrow because the branch changes after session initialization. */
export const readAdvisorSessionBranchAtHostBoundary = (
  ctx: ExtensionContext,
): AdvisorHostReadResult<AdvisorSessionBranch> =>
  readHostContext(
    "session-branch",
    "Advisor could not read the active session branch safely.",
    () => {
      const branch = materializeHostArray<AdvisorSessionBranch[number]>(
        ctx.sessionManager.getBranch?.() ?? [],
      );
      if (
        !branch.every(
          (entry) => entry !== null && typeof entry === "object" && typeof entry.id === "string",
        )
      )
        throw new TypeError("Host session branch entry is invalid.");
      return branch;
    },
  );

export const readAdvisorSessionBranchEffect = (
  ctx: ExtensionContext,
): Effect.Effect<AdvisorSessionBranch, AdvisorHostContextError> =>
  Effect.suspend(() => {
    const result = readAdvisorSessionBranchAtHostBoundary(ctx);
    return result.ok ? Effect.succeed(result.value) : Effect.fail(result.error);
  });

export const readAdvisorSessionLeafIdAtHostBoundary = (
  ctx: ExtensionContext,
): AdvisorHostReadResult<string | null> =>
  readHostContext("session-leaf", "Advisor could not read the active session leaf safely.", () => {
    const leafId = ctx.sessionManager.getLeafId?.() ?? null;
    if (leafId !== null && typeof leafId !== "string")
      throw new TypeError("Host session leaf is invalid.");
    return leafId;
  });

export const readAdvisorSessionIdAtHostBoundary = (
  ctx: ExtensionContext,
): AdvisorHostReadResult<string | undefined> =>
  readHostContext(
    "session-id",
    "Advisor could not read the active session identifier safely.",
    () => {
      const sessionId = ctx.sessionManager.getSessionId?.();
      if (sessionId !== undefined && typeof sessionId !== "string")
        throw new TypeError("Host session identifier is invalid.");
      return sessionId;
    },
  );

export const readAdvisorContextEntriesAtHostBoundary = (
  ctx: ExtensionContext,
): AdvisorHostReadResult<AdvisorContextEntries> =>
  readHostContext(
    "session-context",
    "Advisor could not read the active session context safely.",
    () =>
      materializeHostArray<AdvisorContextEntries[number]>(ctx.sessionManager.buildContextEntries()),
  );

export const readAdvisorContextEntriesEffect = (
  ctx: ExtensionContext,
): Effect.Effect<AdvisorContextEntries, AdvisorHostContextError> =>
  Effect.suspend(() => {
    const result = readAdvisorContextEntriesAtHostBoundary(ctx);
    return result.ok ? Effect.succeed(result.value) : Effect.fail(result.error);
  });

export const readAdvisorParentIdleAtHostBoundary = (
  ctx: ExtensionContext,
): AdvisorHostReadResult<boolean> =>
  readHostContext("parent-idle", "Advisor could not read parent activity safely.", () => {
    const idle = ctx.isIdle();
    if (typeof idle !== "boolean") throw new TypeError("Host activity state is invalid.");
    return idle;
  });

export const readAdvisorPendingMessagesAtHostBoundary = (
  ctx: ExtensionContext,
): AdvisorHostReadResult<boolean> =>
  readHostContext(
    "pending-messages",
    "Advisor could not read pending parent messages safely.",
    () => {
      const pending = ctx.hasPendingMessages();
      if (typeof pending !== "boolean") throw new TypeError("Host pending state is invalid.");
      return pending;
    },
  );

export const readAdvisorSignalAbortedAtHostBoundary = (
  input: Pick<AdvisorSessionInput, "signal">,
): AdvisorHostReadResult<boolean> =>
  readHostContext(
    "abort-state",
    "Advisor could not read host cancellation safely.",
    () => input.signal?.aborted === true,
  );

export const abortAdvisorParentAtHostBoundary = (
  ctx: ExtensionContext,
): AdvisorHostReadResult<void> =>
  readHostContext("parent-abort", "Advisor could not abort the parent safely.", () => ctx.abort());
