// The child-only Pi/Node bridge is intentionally Promise- and callback-shaped.
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { Type } from "typebox";
import { loadCodePreviewSettings } from "pi-code-previews";
import { isProjectTrusted } from "pi-cosmic-core";
import { MAX_PARENT_MESSAGE_CHARS, MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import { SUBAGENT_TOOL_NAMES } from "../run/tool-policy.ts";
import type { SubagentToolInput } from "../tools/schema.ts";
import { encodeSubagentProxyInput } from "../tools/proxy-protocol.ts";
import { registerSubagentProxyManagerCommand } from "../settings/proxy-controller.ts";
import { registerSubagentTools } from "../tools/subagent.ts";
import { clipUtf8Text, safeTextPrefix } from "../run/state.ts";
import type { LocalPiContact, LocalPiParentControl } from "../backend/local-pi-protocol.ts";
import { consumeRuntimeApiCredentials, registerChildPiFastModeHook } from "./host-child-pi.ts";
import { isSubagentChildProcess, subagentChildRunId } from "./host-environment.ts";
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

const ProxyResultSchema = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({
      type: Schema.Literal("text"),
      text: Schema.String.check(Schema.isMaxLength(MAX_TOOL_OUTPUT_CHARS)),
    }),
  ).check(Schema.isMaxLength(64)),
  details: Schema.optional(Schema.Unknown),
});
const ProxyFailureSchema = Schema.Struct({
  message: Schema.String.check(Schema.isMaxLength(MAX_TOOL_OUTPUT_CHARS)),
});

const decodeProxyResult = (source: string): AgentToolResult<unknown> | undefined => {
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(ProxyResultSchema))(source);
  if (Option.isNone(decoded)) return undefined;
  return { content: [...decoded.value.content], details: decoded.value.details ?? {} };
};

const proxyFailure = (source: string): ParentContactError => {
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(ProxyFailureSchema))(source);
  return new ParentContactError({
    message: Option.isSome(decoded)
      ? clipToolReply(decoded.value.message)
      : "The root subagent coordinator rejected the call.",
  });
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
  const openaiFastMode = pi.getFlag("pi-subagents-fast-mode") === true;
  const runtimeApi = consumeRuntimeApiCredentials(process.env);
  if (runtimeApi.apiKey && runtimeApi.provider)
    pi.registerProvider(runtimeApi.provider, { apiKey: runtimeApi.apiKey });
  const pending = new Map<string, Deferred.Deferred<string, ParentContactError>>();
  const pendingProxy = new Map<
    string,
    Deferred.Deferred<AgentToolResult<unknown>, ParentContactError>
  >();
  let proxyToolsRegistered = false;
  const ipc: LocalPiChildIpcChannel = openLocalPiChildIpc();
  let detachIpc: (() => void) | undefined;

  const onControl = (message: LocalPiParentControl) => {
    if (message.type === "proxy_response") {
      const waiter = pendingProxy.get(message.requestId);
      if (!waiter) return;
      pendingProxy.delete(message.requestId);
      const result = message.ok ? decodeProxyResult(message.payloadJson) : undefined;
      Deferred.doneUnsafe(
        waiter,
        result
          ? Effect.succeed(result)
          : Effect.fail(message.ok ? proxyFailure("{}") : proxyFailure(message.payloadJson)),
      );
      return;
    }
    if (message.type === "proxy_notification") {
      let ok = true;
      try {
        pi.sendMessage(
          {
            customType: "pi-subagents-proxy-notification",
            content: message.message,
            display: true,
          },
          { deliverAs: "steer", triggerTurn: true },
        );
      } catch {
        ok = false;
      }
      void Effect.runPromise(
        ipc
          .sendContact({
            channel: "pi-subagents",
            type: "proxy_notification_ack",
            requestId: message.requestId,
            ok,
          })
          .pipe(Effect.ignore),
      );
      return;
    }
    if (message.type === "turn_input_barrier") {
      void Effect.runPromise(
        ipc
          .sendContact({
            channel: "pi-subagents",
            type: "turn_input_barrier_ack",
            requestId: message.requestId,
          })
          .pipe(Effect.ignore),
      );
      return;
    }
    if (message.type === "parent_reply") {
      const waiter = pending.get(message.requestId);
      if (waiter) {
        pending.delete(message.requestId);
        Deferred.doneUnsafe(waiter, Effect.succeed(message.message));
      }
      void Effect.runPromise(
        ipc
          .sendContact({
            channel: "pi-subagents",
            type: "parent_reply_ack",
            requestId: message.ackId,
            ok: waiter !== undefined,
          })
          .pipe(Effect.ignore),
      );
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
    for (const waiter of pendingProxy.values())
      Deferred.doneUnsafe(
        waiter,
        Effect.fail(
          new ParentContactError({ message: "The root subagent coordinator disconnected." }),
        ),
      );
    pendingProxy.clear();
  };

  const proxyCall = (
    input: SubagentToolInput,
    signal: AbortSignal | undefined,
  ): Promise<AgentToolResult<unknown>> => {
    const requestId = `proxy-${process.pid}-${nextRequest++}`;
    const encoded = encodeSubagentProxyInput(input);
    return Effect.runPromise(
      Effect.gen(function* () {
        const waiter = Deferred.makeUnsafe<AgentToolResult<unknown>, ParentContactError>();
        pendingProxy.set(requestId, waiter);
        yield* ipc.sendContact({
          channel: "pi-subagents",
          type: "proxy_request",
          requestId,
          tool: encoded.tool,
          argumentsJson: encoded.argumentsJson,
        });
        return yield* Deferred.await(waiter);
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.sync(() => {
                if (!pendingProxy.delete(requestId)) return;
                void Effect.runPromise(
                  ipc
                    .sendContact({
                      channel: "pi-subagents",
                      type: "proxy_cancel",
                      requestId,
                    })
                    .pipe(Effect.ignore),
                );
              }),
        ),
      ),
      { signal },
    );
  };

  registerChildPiFastModeHook(pi, openaiFastMode);

  pi.on("session_start", (_event, ctx) => {
    if (!detachIpc) detachIpc = ipc.listen({ onControl, onDisconnect: rejectPending });
    if (proxyToolsRegistered) return;
    return Promise.resolve(loadCodePreviewSettings(ctx.cwd, isProjectTrusted(ctx)))
      .catch(() => undefined)
      .then(() => {
        if (proxyToolsRegistered) return;
        registerSubagentTools(pi, {
          environment: { cwd: ctx.cwd, projectTrusted: isProjectTrusted(ctx) },
          proxyCall: (input, signal) => proxyCall(input, signal),
          run: () => Promise.reject(new Error("Nested Pi uses the root coordinator proxy.")),
        });
        pi.setActiveTools([...new Set([...pi.getActiveTools(), ...SUBAGENT_TOOL_NAMES])]);
        const runId = subagentChildRunId();
        if (runId) registerSubagentProxyManagerCommand(pi, runId, proxyCall);
        proxyToolsRegistered = true;
      });
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
