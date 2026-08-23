// The child-only Pi/Node bridge is intentionally Promise- and callback-shaped.
import { hasObjectRuntimeType } from "pi-cosmic-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { FAST_SERVICE_TIER, supportsFastModel } from "pi-better-openai/fast-models";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { Type } from "typebox";
import { MAX_PARENT_MESSAGE_CHARS, MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import { clipUtf8Text, safeTextPrefix } from "../run/state.ts";
import type { LocalPiContact, LocalPiParentControl } from "../backend/local-pi-protocol.ts";
import { isSubagentChildProcess } from "./host-environment.ts";
import {
  openLocalPiChildIpc,
  ParentContactError,
  type LocalPiChildIpcChannel,
} from "./local-pi-ipc.ts";
const PARENT_REPLY_PREFIX = "Parent replied: ";
const QUESTION_TIMEOUT_MILLIS = 10 * 60_000;
const MAX_TOOL_REPLY_BYTES = MAX_TOOL_OUTPUT_CHARS - PARENT_REPLY_PREFIX.length;
let nextRequest = 1;

const clipToolReply = (value: string): string => clipUtf8Text(value, MAX_TOOL_REPLY_BYTES);

/** Reads and scrubs the one-shot runtime API credentials from the given environment snapshot. */
const consumeRuntimeApiCredentials = (environment: NodeJS.ProcessEnv) => {
  const apiKey = environment.PI_SUBAGENT_RUNTIME_API_KEY;
  const provider = environment.PI_SUBAGENT_RUNTIME_API_PROVIDER;
  delete environment.PI_SUBAGENT_RUNTIME_API_KEY;
  delete environment.PI_SUBAGENT_RUNTIME_API_PROVIDER;
  return { apiKey, provider };
};

type ContactParentEnvelope = Extract<LocalPiContact, { readonly type: "contact_parent" }>;
type ContactCancelEnvelope = Extract<LocalPiContact, { readonly type: "contact_cancel" }>;

const ContactParentParameters = Type.Object(
  {
    kind: StringEnum(["progress", "question", "warning"] as const),
    message: Type.String({
      minLength: 1,
      maxLength: MAX_PARENT_MESSAGE_CHARS,
      pattern: ".*\\S.*",
    }),
  },
  { additionalProperties: false },
);

export default function subagentChildBridge(pi: ExtensionAPI): void {
  if (!isSubagentChildProcess()) return;
  pi.registerFlag("pi-subagents-fast-mode", {
    description: "Private OpenAI fast-mode request for this subagent",
    type: "boolean",
    default: false,
  });
  const fastMode = pi.getFlag("pi-subagents-fast-mode") === true;
  const runtimeApi = consumeRuntimeApiCredentials(process.env);
  if (runtimeApi.apiKey && runtimeApi.provider)
    pi.registerProvider(runtimeApi.provider, { apiKey: runtimeApi.apiKey });
  const pending = new Map<string, Deferred.Deferred<string, ParentContactError>>();
  const ipc: LocalPiChildIpcChannel = openLocalPiChildIpc();
  let detachIpc: (() => void) | undefined;

  const onControl = (message: LocalPiParentControl) => {
    if (message.type === "parent_reply") {
      const waiter = pending.get(message.requestId);
      if (!waiter) return;
      pending.delete(message.requestId);
      Deferred.doneUnsafe(waiter, Effect.succeed(message.message));
      return;
    }
    if (message.type === "peer_notice") {
      try {
        // Dynamic fleet changes should inform a later parent prompt without steering the
        // current turn; steering an active child causes repeated final responses.
        pi.sendMessage(
          {
            customType: "pi-subagents-peer-notice",
            content: message.message,
            display: true,
          },
          { deliverAs: "nextTurn", triggerTurn: false },
        );
      } catch {
        // The child may already be shutting down.
      }
    }
  };

  const rejectPending = () => {
    for (const waiter of pending.values())
      Deferred.doneUnsafe(
        waiter,
        Effect.fail(
          new ParentContactError({
            message: "The parent subagent supervisor disconnected.",
          }),
        ),
      );
    pending.clear();
  };

  pi.on("before_provider_request", (event, ctx) => {
    if (
      !fastMode ||
      !ctx.model ||
      !supportsFastModel(ctx.model.provider, ctx.model.id) ||
      !event.payload ||
      !hasObjectRuntimeType(event.payload) ||
      Array.isArray(event.payload)
    )
      return undefined;
    return { ...event.payload, service_tier: FAST_SERVICE_TIER };
  });

  pi.on("session_start", () => {
    if (detachIpc) return;
    detachIpc = ipc.listen({ onControl, onDisconnect: rejectPending });
  });

  pi.on("session_shutdown", () => {
    detachIpc?.();
    detachIpc = undefined;
    rejectPending();
  });

  pi.registerTool({
    name: "contact_parent",
    label: "Contact Parent",
    description:
      "Send progress, record a non-blocking warning in parent-visible run status, or ask a blocking parent question. Repeat warnings in the final report; use a question instead when a risk could invalidate work the parent is doing now.",
    parameters: ContactParentParameters,
    executionMode: "sequential",
    execute(_toolCallId, params, signal) {
      const requestId = `contact-${process.pid}-${nextRequest++}`;
      const envelope: ContactParentEnvelope = {
        channel: "pi-subagents",
        type: "contact_parent",
        requestId,
        kind: params.kind,
        message: safeTextPrefix(params.message, MAX_PARENT_MESSAGE_CHARS),
      };
      if (params.kind !== "question") {
        return Effect.runPromise(ipc.sendContact(envelope)).then(() => ({
          content: [{ type: "text" as const, text: `Parent received ${params.kind}.` }],
          details: {},
        }));
      }

      return Effect.runPromise(
        Effect.gen(function* () {
          const waiter = Deferred.makeUnsafe<string, ParentContactError>();
          pending.set(requestId, waiter);
          yield* ipc.sendContact(envelope).pipe(
            Effect.catch((error) =>
              error.code === "transport_not_sent"
                ? Effect.sync(() => {
                    if (pending.get(requestId) === waiter) pending.delete(requestId);
                  }).pipe(Effect.andThen(Effect.fail(error)))
                : Effect.fail(error),
            ),
          );
          return yield* Deferred.await(waiter);
        }).pipe(
          // A parent that never replies must not block this child forever.
          Effect.timeout(QUESTION_TIMEOUT_MILLIS),
          Effect.mapError((error) =>
            error instanceof ParentContactError
              ? error
              : new ParentContactError({
                  message: "Parent question timed out without a reply.",
                }),
          ),
          // Cancellation (tool abort or timeout) tells the parent to stop waiting too;
          // the supervisor view already understands the cancelled-question event.
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.sync(() => {
                  if (!pending.delete(requestId)) return;
                  const cancel: ContactCancelEnvelope = {
                    channel: "pi-subagents",
                    type: "contact_cancel",
                    requestId,
                  };
                  void Effect.runPromise(ipc.sendContact(cancel).pipe(Effect.ignore));
                }),
          ),
        ),
        { signal },
      ).then(
        (reply) => ({
          content: [
            {
              type: "text" as const,
              text: `${PARENT_REPLY_PREFIX}${clipToolReply(reply)}`,
            },
          ],
          details: {},
        }),
        (error) => {
          if (signal?.aborted) throw new Error("Parent question was cancelled.");
          throw error instanceof ParentContactError ? new Error(error.message) : error;
        },
      );
    },
  });
}
