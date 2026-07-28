// The child-only Pi/Node bridge is intentionally Promise- and callback-shaped.
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/asyncFunction:off
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Type } from "typebox";
import {
  MAX_PARENT_MESSAGE_CHARS,
  MAX_PROTOCOL_ID_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
} from "../run/limits.ts";
import { clipUtf8Text, safeTextPrefix } from "../run/state.ts";

const ProtocolIdSchema = Schema.String.check(Schema.isMaxLength(MAX_PROTOCOL_ID_CHARS));
const ParentMessageSchema = Schema.String.check(Schema.isMaxLength(MAX_PARENT_MESSAGE_CHARS));
const PARENT_REPLY_PREFIX = "Parent replied: ";
const MAX_TOOL_REPLY_BYTES = MAX_TOOL_OUTPUT_CHARS - PARENT_REPLY_PREFIX.length;
let nextRequest = 1;

const clipToolReply = (value: string): string => clipUtf8Text(value, MAX_TOOL_REPLY_BYTES);

interface PendingReply {
  readonly resolve: (message: string) => void;
  readonly reject: (error: Error) => void;
}

const ParentControlSchema = Schema.Union([
  Schema.Struct({
    channel: Schema.Literal("pi-subagents"),
    type: Schema.Literal("parent_reply"),
    requestId: ProtocolIdSchema,
    message: ParentMessageSchema,
  }),
  Schema.Struct({
    channel: Schema.Literal("pi-subagents"),
    type: Schema.Literal("peer_notice"),
    message: ParentMessageSchema,
  }),
]);

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

function sendIpc(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) {
      reject(new Error("The parent subagent supervisor is unavailable."));
      return;
    }
    process.send(message, (error) => {
      if (error) reject(new Error("Unable to contact the parent subagent supervisor."));
      else resolve();
    });
  });
}

export default function subagentChildBridge(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD !== "1") return;
  const runtimeApiKey = process.env.PI_SUBAGENT_RUNTIME_API_KEY;
  const runtimeApiProvider = process.env.PI_SUBAGENT_RUNTIME_API_PROVIDER;
  delete process.env.PI_SUBAGENT_RUNTIME_API_KEY;
  delete process.env.PI_SUBAGENT_RUNTIME_API_PROVIDER;
  if (runtimeApiKey && runtimeApiProvider)
    pi.registerProvider(runtimeApiProvider, { apiKey: runtimeApiKey });
  const pending = new Map<string, PendingReply>();
  let listening = false;

  const onMessage = (raw: unknown) => {
    const message = Option.getOrUndefined(Schema.decodeUnknownOption(ParentControlSchema)(raw));
    if (!message) return;
    if (message.type === "parent_reply") {
      const waiter = pending.get(message.requestId);
      if (!waiter) return;
      pending.delete(message.requestId);
      waiter.resolve(message.message);
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
      waiter.reject(new Error("The parent subagent supervisor disconnected."));
    pending.clear();
  };

  pi.on("session_start", () => {
    if (listening) return;
    listening = true;
    process.on("message", onMessage);
    process.on("disconnect", rejectPending);
  });

  pi.on("session_shutdown", () => {
    if (!listening) return;
    listening = false;
    process.off("message", onMessage);
    process.off("disconnect", rejectPending);
    rejectPending();
  });

  pi.registerTool({
    name: "contact_parent",
    label: "Contact Parent",
    description:
      "Send progress, a warning, or a blocking question to the parent agent supervising this subagent.",
    parameters: ContactParentParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const requestId = `contact-${process.pid}-${nextRequest++}`;
      const envelope = {
        channel: "pi-subagents" as const,
        type: "contact_parent" as const,
        requestId,
        kind: params.kind,
        message: safeTextPrefix(params.message, MAX_PARENT_MESSAGE_CHARS),
      };
      if (params.kind !== "question") {
        await sendIpc(envelope);
        return {
          content: [{ type: "text" as const, text: `Parent received ${params.kind}.` }],
          details: {},
        };
      }

      const reply = await new Promise<string>((resolve, reject) => {
        const abort = () => {
          pending.delete(requestId);
          reject(new Error("Parent question was cancelled."));
        };
        if (signal?.aborted) {
          reject(new Error("Parent question was cancelled."));
          return;
        }
        pending.set(requestId, {
          resolve: (message) => {
            signal?.removeEventListener("abort", abort);
            resolve(message);
          },
          reject: (error) => {
            signal?.removeEventListener("abort", abort);
            reject(error);
          },
        });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
          return;
        }
        void sendIpc(envelope).catch((error: unknown) => {
          pending.delete(requestId);
          signal?.removeEventListener("abort", abort);
          reject(error instanceof Error ? error : new Error("Unable to contact parent."));
        });
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `${PARENT_REPLY_PREFIX}${clipToolReply(reply)}`,
          },
        ],
        details: {},
      };
    },
  });
}
