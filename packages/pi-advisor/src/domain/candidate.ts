import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { stringifyJson } from "../boundary/json.ts";
import { snapshotData } from "../boundary/safe-data.ts";
import { stringifyRedactedObservation } from "../review/observation-protocol.ts";
import { isRecord } from "../shared/utils.ts";

export type AdvisorReviewPhase = "final" | "progress";

export type CandidateClassification =
  | { eligible: true; candidate: string; phase: AdvisorReviewPhase }
  | { eligible: false; reason: "not-assistant" | "empty" | "incomplete" };

/** Extract user-visible text from a safely snapshotted host message. */
export function contentText(message: unknown): string {
  message = snapshotData(message);
  if (!isRecord(message)) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
}

export const safeObservationJson = (value: unknown): string =>
  stringifyRedactedObservation(value).slice(0, 12_000);

export function assistantStopReason(message: unknown): "stop" | "aborted" | "error" | "length" {
  message = snapshotData(message);
  if (!isRecord(message)) return "error";
  return message.stopReason === "aborted" ||
    message.stopReason === "error" ||
    message.stopReason === "length"
    ? message.stopReason
    : "stop";
}

export function assistantToolCalls(message: unknown): string[] {
  message = snapshotData(message);
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.flatMap((part) =>
    isRecord(part) && part.type === "toolCall"
      ? [
          `${typeof part.name === "string" ? part.name : "unknown"} ${safeObservationJson(part.arguments)}`,
        ]
      : [],
  );
}

export function isGenuineUserMessage(message: unknown): boolean {
  const snapshot = snapshotData(message);
  return isRecord(snapshot) && snapshot.role === "user";
}

export function classifyReviewCheckpoint(event: TurnEndEvent): CandidateClassification {
  const message = snapshotData(event.message);
  if (!isRecord(message) || message.role !== "assistant") {
    return { eligible: false, reason: "not-assistant" };
  }
  if (
    message.stopReason === "aborted" ||
    message.stopReason === "error" ||
    message.stopReason === "length"
  )
    return { eligible: false, reason: "incomplete" };
  if (!Array.isArray(message.content)) return { eligible: false, reason: "empty" };
  const hasToolCall = message.content.some((part) => isRecord(part) && part.type === "toolCall");
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

export function assistantCheckpointText(message: unknown): string | undefined {
  message = snapshotData(message);
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return undefined;
  }
  const parts = message.content.flatMap((part) => {
    if (!isRecord(part)) return [];
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      return [part.text.trim()];
    }
    if (part.type !== "toolCall") return [];
    const name = typeof part.name === "string" && part.name ? part.name : "unknown";
    let args = "";
    try {
      args = part.arguments === undefined ? "" : ` ${stringifyJson(part.arguments)}`;
    } catch {
      args = " [unserializable arguments]";
    }
    return [`[tool call: ${name}${args}]`];
  });
  const text = parts.join("\n").trim();
  return text || undefined;
}

export function assistantText(message: unknown): string | undefined {
  message = snapshotData(message);
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return undefined;
  }
  const text = message.content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n")
    .trim();
  return text || undefined;
}
