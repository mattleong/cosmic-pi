import * as Predicate from "effect/Predicate";

import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { snapshotData } from "./safe-data.ts";
import { stringifyRedactedObservation } from "./redaction.ts";
import { isJsonObject } from "pi-cosmic-core";

export type AdvisorReviewPhase = "final" | "progress";

export type CandidateClassification =
  | { eligible: true; candidate: string; phase: AdvisorReviewPhase }
  | { eligible: false; reason: "not-assistant" | "empty" | "incomplete" };

/** Extract user-visible text from a safely snapshotted host message. */
export function contentText<MessageInput>(message: MessageInput): string {
  const snapshot = snapshotData(message);
  if (!isJsonObject(snapshot)) return "";
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

export function assistantStopReason<MessageInput>(
  message: MessageInput,
): "stop" | "aborted" | "error" | "length" {
  const snapshot = snapshotData(message);
  if (!isJsonObject(snapshot)) return "error";
  return snapshot.stopReason === "aborted" ||
    snapshot.stopReason === "error" ||
    snapshot.stopReason === "length"
    ? snapshot.stopReason
    : "stop";
}

export function assistantToolCalls<MessageInput>(message: MessageInput): string[] {
  const snapshot = snapshotData(message);
  if (!isJsonObject(snapshot) || !Array.isArray(snapshot.content)) return [];
  return snapshot.content.flatMap((part) =>
    isJsonObject(part) && part.type === "toolCall"
      ? [
          `${Predicate.isString(part.name) ? part.name : "unknown"} ${safeObservationJson(part.arguments)}`,
        ]
      : [],
  );
}

export function isGenuineUserMessage<MessageInput>(message: MessageInput): boolean {
  const snapshot = snapshotData(message);
  return isJsonObject(snapshot) && snapshot.role === "user";
}

export function classifyReviewCheckpoint(event: TurnEndEvent): CandidateClassification {
  const message = snapshotData(event.message);
  if (!isJsonObject(message) || message.role !== "assistant") {
    return { eligible: false, reason: "not-assistant" };
  }
  if (
    message.stopReason === "aborted" ||
    message.stopReason === "error" ||
    message.stopReason === "length"
  )
    return { eligible: false, reason: "incomplete" };
  if (!Array.isArray(message.content)) return { eligible: false, reason: "empty" };
  const hasToolCall = message.content.some(
    (part) => isJsonObject(part) && part.type === "toolCall",
  );
  if (hasToolCall) {
    const candidate = assistantCheckpointText(message);
    return candidate
      ? { eligible: true, candidate, phase: "progress" }
      : { eligible: false, reason: "empty" };
  }
  if (message.stopReason !== "stop") return { eligible: false, reason: "incomplete" };
  const candidate = assistantText(message);
  return candidate
    ? { eligible: true, candidate, phase: "final" }
    : { eligible: false, reason: "empty" };
}

export function assistantCheckpointText<MessageInput>(message: MessageInput): string | undefined {
  const snapshot = snapshotData(message);
  if (
    !isJsonObject(snapshot) ||
    snapshot.role !== "assistant" ||
    !Array.isArray(snapshot.content)
  ) {
    return undefined;
  }
  const parts = snapshot.content.flatMap((part) => {
    if (!isJsonObject(part)) return [];
    if (part.type === "text" && Predicate.isString(part.text) && part.text.trim()) {
      return [part.text.trim()];
    }
    if (part.type !== "toolCall") return [];
    const name = Predicate.isString(part.name) && part.name ? part.name : "unknown";
    let args = "";
    try {
      args = part.arguments === undefined ? "" : ` ${JSON.stringify(part.arguments)}`;
    } catch {
      args = " [unserializable arguments]";
    }
    return [`[tool call: ${name}${args}]`];
  });
  const text = parts.join("\n").trim();
  return text || undefined;
}

export function assistantText<MessageInput>(message: MessageInput): string | undefined {
  const snapshot = snapshotData(message);
  if (
    !isJsonObject(snapshot) ||
    snapshot.role !== "assistant" ||
    !Array.isArray(snapshot.content)
  ) {
    return undefined;
  }
  const text = snapshot.content
    .flatMap((part) =>
      isJsonObject(part) && part.type === "text" && Predicate.isString(part.text)
        ? [part.text]
        : [],
    )
    .join("\n")
    .trim();
  return text || undefined;
}
