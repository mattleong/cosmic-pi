import { createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { snapshotData } from "../domain/safe-data.ts";
import { isRecord } from "../shared/utils.ts";
import { AdvisorModelError } from "./client.ts";
import { ADVISOR_TOOL_NAMES } from "./tools.ts";

export const assistantTextAfterPromptEffect = Effect.fn("AdvisorCheckpoint.correlatedText")(
  function* (messages: readonly unknown[], prompt: string) {
    return yield* Effect.try({
      try: () => assistantTextAfterPrompt(messages, prompt),
      catch: (error) =>
        error instanceof AdvisorModelError
          ? error
          : new AdvisorModelError({ message: "Advisor correlated response was unavailable." }),
    });
  },
);

export function assistantTextAfterPrompt(messages: readonly unknown[], prompt: string): string {
  let promptIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = snapshotData(messages[index]);
    if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.content)) continue;
    if (messageText(message) === prompt) {
      promptIndex = index;
      break;
    }
  }
  if (promptIndex < 0) {
    throw new AdvisorModelError({
      message: "Advisor correlated finalization prompt was not recorded.",
    });
  }
  for (let index = promptIndex + 1; index < messages.length; index += 1) {
    const message = snapshotData(messages[index]);
    if (!isRecord(message) || message.role !== "assistant") continue;
    const text = messageText(message);
    if (text) return text;
  }
  throw new AdvisorModelError({
    message: "Advisor checkpoint contained no correlated finalized assistant text.",
  });
}

function messageText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n")
    .trim();
}

export function unsafeToolNames(): string[] {
  const safe = new Set<string>(ADVISOR_TOOL_NAMES);
  return ["bash", "write", "edit", "patch", "exec", "process", "custom", "all"].filter(
    (name) => !safe.has(name),
  );
}

export type CreatedAgentSession = Awaited<ReturnType<typeof createAgentSession>>;

export const createChildSessionEffect = (
  operation: () => ReturnType<typeof createAgentSession>,
  cleanupBarrier: Deferred.Deferred<void>,
): Effect.Effect<CreatedAgentSession, AdvisorModelError> =>
  Effect.callback<CreatedAgentSession, AdvisorModelError>((resume) => {
    const completeBarrier = Deferred.succeed(cleanupBarrier, undefined).pipe(Effect.asVoid);
    const resumeNoThrow = (
      effect: Effect.Effect<Awaited<ReturnType<typeof createAgentSession>>, AdvisorModelError>,
    ) => {
      try {
        resume(effect.pipe(Effect.ensuring(completeBarrier)));
      } catch {
        /* Effect callback resumption is isolated from the native Promise chain */
      }
    };
    let pending: ReturnType<typeof createAgentSession>;
    try {
      pending = operation();
    } catch {
      resumeNoThrow(
        Effect.fail(
          new AdvisorModelError({ message: "Advisor child session could not be created." }),
        ),
      );
      return;
    }

    try {
      void pending.then(
        (result) => resumeNoThrow(Effect.succeed(result)),
        () =>
          resumeNoThrow(
            Effect.fail(
              new AdvisorModelError({ message: "Advisor child session could not be created." }),
            ),
          ),
      );
    } catch {
      resumeNoThrow(
        Effect.fail(
          new AdvisorModelError({ message: "Advisor child session could not be created." }),
        ),
      );
      return;
    }

    // A cancelled foreign Promise cannot remain scope-owned. Register no-throw synchronous
    // cleanup for a possible late session before admitting replacement or shutdown.
    return Effect.sync(() => observeLateChildSession(pending)).pipe(
      Effect.andThen(completeBarrier),
    );
  });

type AdvisorSessionAbortOutcome = "settled" | "failed" | "timed-out";
export const awaitSessionAbortEffect = (
  session: AgentSession,
  timeoutMs: number,
): Effect.Effect<AdvisorSessionAbortOutcome> =>
  Effect.tryPromise({
    try: () => session.abort(),
    catch: () => new AdvisorModelError({ message: "Advisor child abort failed." }),
  }).pipe(
    Effect.as("settled" as const),
    Effect.catch(() => Effect.succeed("failed" as const)),
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.map((outcome) => (Option.isNone(outcome) ? "timed-out" : outcome.value)),
  );
export const stopSessionEffect = (session: AgentSession, abort: boolean, abortTimeoutMs: number) =>
  Effect.uninterruptibleMask(() =>
    (abort
      ? Effect.interruptible(awaitSessionAbortEffect(session, abortTimeoutMs)).pipe(Effect.asVoid)
      : Effect.void
    ).pipe(Effect.ensuring(disposeSessionNowEffect(session))),
  );
export const disposeSessionNowEffect = (session: AgentSession) =>
  Effect.sync(() => disposeSessionNow(session));
export function disposeSessionNow(session: AgentSession): void {
  try {
    session.dispose();
  } catch {
    /* disposal defects are isolated after the resource is detached */
  }
}
function observeLateChildSession(pending: ReturnType<typeof createAgentSession>): void {
  try {
    void pending.then(
      (result) => {
        try {
          disposeSessionNow(result.session);
        } catch {
          /* hostile Promise results cannot escape the late-cleanup callback */
        }
      },
      () => undefined,
    );
  } catch {
    /* hostile thenables cannot escape the late-cleanup adapter */
  }
}
export const toModelError = (message: string) => (error: unknown) =>
  error instanceof AdvisorModelError ? error : new AdvisorModelError({ message: message });

export function projectActiveToolNamesAtHostBoundary(session: AgentSession): readonly string[] {
  try {
    const names = [...session.getActiveToolNames()];
    return names.every((name): name is string => typeof name === "string") ? names : [];
  } catch {
    // Synchronous status projection is diagnostic-only and cannot defect the parent runtime.
    return [];
  }
}

export function isToolCallDelta(value: unknown): value is { delta: string } {
  return (
    isRecord(value) &&
    (value.type === "toolcall_delta" || value.type === "tool_call_delta") &&
    typeof value.delta === "string"
  );
}

export function isolateCallback(action: () => void): void {
  try {
    action();
  } catch {
    /* host diagnostics are best-effort and never own cleanup */
  }
}
