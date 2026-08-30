import * as Predicate from "effect/Predicate";

import { createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { invokeHostCallback, isJsonObject } from "pi-cosmic-core";
import { snapshotData } from "../domain/safe-data.ts";
import { AdvisorModelError } from "./client.ts";
import { ADVISOR_TOOL_NAMES } from "./tools.ts";

const AdvisorMessageContent = Schema.Array(Schema.Unknown);
const AdvisorUserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: AdvisorMessageContent,
});
const AdvisorAssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: AdvisorMessageContent,
});
const AdvisorTextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
type AdvisorSessionMessage =
  | Schema.Schema.Type<typeof AdvisorUserMessage>
  | Schema.Schema.Type<typeof AdvisorAssistantMessage>;

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
    const message = Schema.decodeUnknownOption(AdvisorUserMessage)(snapshotData(messages[index]));
    if (Option.isNone(message)) continue;
    if (messageText(message.value) === prompt) {
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
    const message = Schema.decodeUnknownOption(AdvisorAssistantMessage)(
      snapshotData(messages[index]),
    );
    if (Option.isNone(message)) continue;
    const text = messageText(message.value);
    if (text) return text;
  }
  throw new AdvisorModelError({
    message: "Advisor checkpoint contained no correlated finalized assistant text.",
  });
}

function messageText(message: AdvisorSessionMessage): string {
  return message.content
    .flatMap((part) => {
      const text = Schema.decodeUnknownOption(AdvisorTextPart)(part);
      return Option.isSome(text) ? [text.value.text] : [];
    })
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
export const toModelError =
  (message: string) =>
  <ErrorInput>(error: ErrorInput) =>
    error instanceof AdvisorModelError ? error : new AdvisorModelError({ message: message });

export function projectActiveToolNamesAtHostBoundary(session: AgentSession): readonly string[] {
  try {
    const names = [...session.getActiveToolNames()];
    return names.every((name): name is string => Predicate.isString(name)) ? names : [];
  } catch {
    // Synchronous status projection is diagnostic-only and cannot defect the parent runtime.
    return [];
  }
}

export function isToolCallDelta<ValueInput>(
  value: ValueInput,
): value is ValueInput & { delta: string } {
  return (
    isJsonObject(value) &&
    (value.type === "toolcall_delta" || value.type === "tool_call_delta") &&
    Predicate.isString(value.delta)
  );
}

export function isolateCallback(action: () => void): void {
  invokeHostCallback(action, undefined);
}
