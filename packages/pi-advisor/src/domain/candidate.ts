import * as Predicate from "effect/Predicate";
import { isJsonObject } from "pi-cosmic-core";
import { stringifyRedactedObservation, stringifyRedactedObservationSnapshot } from "./redaction.ts";
import { snapshotData } from "./safe-data.ts";

export type AdvisorReviewPhase = "final" | "progress";

export type CandidateClassification =
  | { eligible: true; candidate: string; phase: AdvisorReviewPhase }
  | { eligible: false; reason: "not-assistant" | "empty" | "incomplete" };

export interface AssistantTurnInspection {
  readonly classification: CandidateClassification;
  readonly stopReason: "stop" | "aborted" | "error" | "length";
  readonly toolCalls: string[];
}

/** Snapshot and inspect one untrusted user message. */
export function inspectUserMessage<MessageInput>(message: MessageInput): string | undefined {
  const snapshot = snapshotData(message);
  if (!isJsonObject(snapshot) || snapshot.role !== "user") return undefined;
  if (Predicate.isString(snapshot.content)) return snapshot.content;
  if (!Array.isArray(snapshot.content)) return "";
  return snapshot.content
    .flatMap((part) =>
      isJsonObject(part) && part.type === "text" && Predicate.isString(part.text)
        ? [part.text]
        : [],
    )
    .join("\n");
}

export const safeObservationJson = <Value>(value: Value): string =>
  stringifyRedactedObservation(value).slice(0, 12_000);

/** Snapshot and inspect one untrusted assistant message. */
export function inspectAssistantMessage<MessageInput>(
  messageInput: MessageInput,
): AssistantTurnInspection {
  const message = snapshotData(messageInput);
  const stopReason =
    !isJsonObject(message) || message.stopReason === "error"
      ? "error"
      : message.stopReason === "aborted" || message.stopReason === "length"
        ? message.stopReason
        : "stop";
  if (!isJsonObject(message) || message.role !== "assistant") {
    return {
      classification: { eligible: false, reason: "not-assistant" },
      stopReason,
      toolCalls: [],
    };
  }
  if (
    message.stopReason === "aborted" ||
    message.stopReason === "error" ||
    message.stopReason === "length"
  ) {
    return {
      classification: { eligible: false, reason: "incomplete" },
      stopReason,
      toolCalls: [],
    };
  }
  if (!Array.isArray(message.content)) {
    return {
      classification: { eligible: false, reason: "empty" },
      stopReason,
      toolCalls: [],
    };
  }

  let hasToolCall = false;
  const textParts: string[] = [];
  const checkpointParts: string[] = [];
  const toolCalls: string[] = [];
  for (const part of message.content) {
    if (!isJsonObject(part)) continue;
    if (part.type === "text" && Predicate.isString(part.text)) {
      textParts.push(part.text);
      if (part.text.trim()) checkpointParts.push(part.text.trim());
      continue;
    }
    if (part.type !== "toolCall") continue;
    hasToolCall = true;
    const name = Predicate.isString(part.name) && part.name ? part.name : "unknown";
    const serializedArguments =
      part.arguments === undefined
        ? undefined
        : stringifyRedactedObservationSnapshot(part.arguments);
    checkpointParts.push(
      `[tool call: ${name}${serializedArguments === undefined ? "" : ` ${serializedArguments}`}]`,
    );
    toolCalls.push(`${name} ${(serializedArguments ?? "[unavailable]").slice(0, 12_000)}`);
  }

  if (hasToolCall) {
    const candidate = checkpointParts.join("\n").trim();
    return {
      classification: candidate
        ? { eligible: true, candidate, phase: "progress" }
        : { eligible: false, reason: "empty" },
      stopReason,
      toolCalls,
    };
  }
  if (message.stopReason !== "stop") {
    return {
      classification: { eligible: false, reason: "incomplete" },
      stopReason,
      toolCalls: [],
    };
  }
  const candidate = textParts.join("\n").trim();
  return {
    classification: candidate
      ? { eligible: true, candidate, phase: "final" }
      : { eligible: false, reason: "empty" },
    stopReason,
    toolCalls: [],
  };
}
