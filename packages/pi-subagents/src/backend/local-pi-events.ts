import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { safeTextPrefix } from "pi-cosmic-core";
import type { ChildProcessHandle } from "../boundary/child-process.ts";
import { SubagentProcessError, type SubagentError } from "../run/errors.ts";
import { emptyUsage } from "../run/model.ts";
import {
  MAX_ERROR_CHARS,
  MAX_FINAL_TEXT_CHARS,
  sanitizeDiagnosticText,
  sanitizeOutputText,
} from "../run/state.ts";
import {
  assistantText,
  decodeAssistantMessage,
  MAX_STRUCTURED_RESULT_REJECTION_CHARS,
  type LocalPiContact,
  type RpcChildEnvelope,
} from "./local-pi-protocol.ts";
import type { BackendEvent } from "./model.ts";

type LocalPiContactAck = Extract<
  LocalPiContact,
  { readonly type: "parent_reply_ack" | "proxy_notification_ack" | "turn_input_barrier_ack" }
>;

export const normalizeRpcEvent = (
  envelope: RpcChildEnvelope,
  assignmentEpoch: number,
): Effect.Effect<BackendEvent | undefined, Schema.SchemaError> => {
  switch (envelope.type) {
    case "agent_start":
      return Effect.succeed<BackendEvent>({ type: "run_started", assignmentEpoch });
    case "agent_settled":
      return Effect.succeed<BackendEvent>({ type: "run_settled", assignmentEpoch });
    case "message_update":
      return Effect.succeed(
        envelope.assistantMessageEvent.type === "text_delta" && envelope.assistantMessageEvent.delta
          ? ({ type: "activity", assignmentEpoch } as const)
          : undefined,
      );
    case "message_end":
      return decodeAssistantMessage(envelope.message).pipe(
        Effect.map((message): BackendEvent | undefined => {
          if (!message) return undefined;
          const text = sanitizeOutputText(assistantText(message), MAX_FINAL_TEXT_CHARS);
          return {
            type: "assistant_message",
            assignmentEpoch,
            ...(text && { text }),
            usage: emptyUsage(),
            terminal: {
              stopReason: message.stopReason,
              text,
              ...(message.errorMessage && {
                errorMessage: sanitizeDiagnosticText(message.errorMessage, MAX_ERROR_CHARS),
              }),
            },
          };
        }),
      );
    case "tool_execution_start":
      return Effect.succeed<BackendEvent>({
        type: "tool_started",
        assignmentEpoch,
        toolCallId: envelope.toolCallId,
        toolName: envelope.toolName,
        args: envelope.args,
      });
    case "tool_execution_end":
      return Effect.succeed<BackendEvent>({
        type: "tool_finished",
        assignmentEpoch,
        toolCallId: envelope.toolCallId,
        toolName: envelope.toolName,
        isError: envelope.isError,
      });
    case "extension_error":
      return Effect.succeed<BackendEvent>({
        type: "warning",
        message: envelope.error,
      });
    case "agent_end":
    case "extension_ui_request":
    case "ignored":
    case "message_start":
    case "response":
      return Effect.undefined;
  }
};

export const parentContactAckOutcome = (
  contact: LocalPiContactAck,
): Effect.Effect<void, SubagentError> =>
  contact.type === "turn_input_barrier_ack" || contact.ok
    ? Effect.void
    : Effect.fail(
        new SubagentProcessError(
          contact.type === "parent_reply_ack"
            ? {
                operation: "deliver parent reply to",
                code: "question_ownership_mismatch",
                message:
                  "Subagent no longer owns the parent question, so the reply was not applied.",
              }
            : {
                operation: "deliver descendant notification to",
                code: "transport_not_sent",
                message: "Subagent rejected a descendant notification before queueing it.",
              },
        ),
      );

export const normalizeParentContact = (
  contact: Exclude<LocalPiContact, LocalPiContactAck>,
  assignmentEpoch: number,
  child: Pick<ChildProcessHandle, "sendContactControl">,
): BackendEvent => {
  switch (contact.type) {
    case "contact_parent":
      return {
        type: "supervisor_contact",
        assignmentEpoch,
        requestId: contact.requestId,
        kind: contact.kind,
        message: contact.message,
      };
    case "contact_cancel":
      return {
        type: "supervisor_question_cancelled",
        assignmentEpoch,
        requestId: contact.requestId,
      };
    case "proxy_request":
      return {
        type: "proxy_request",
        requestId: contact.requestId,
        tool: contact.tool,
        argumentsJson: contact.argumentsJson,
        respond: (ok, payloadJson) =>
          child.sendContactControl({
            channel: "pi-subagents",
            type: "proxy_response",
            requestId: contact.requestId,
            ok,
            payloadJson,
          }),
      };
    case "proxy_cancel":
      return { type: "proxy_cancel", requestId: contact.requestId };
    case "structured_result":
      return {
        type: "structured_result",
        assignmentEpoch,
        valueJson: contact.valueJson,
        respond: (ok, message) =>
          child.sendContactControl({
            channel: "pi-subagents",
            type: "structured_result_ack",
            requestId: contact.requestId,
            ok,
            ...(message !== undefined && {
              message: safeTextPrefix(message, MAX_STRUCTURED_RESULT_REJECTION_CHARS),
            }),
          }),
      };
  }
};
