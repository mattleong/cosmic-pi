import * as Predicate from "effect/Predicate";

import { redactSensitiveText, stringifyRedactedObservation } from "../domain/redaction.ts";
import { snapshotDataRecord } from "../domain/safe-data.ts";
import { isRecord } from "../shared/utils.ts";

export const DEFAULT_MAX_CONTEXT_CHARS = 240_000;

export const ADVISOR_CONTEXT_TRUNCATION_MARKER = "[... advisor context truncated ...]";

export type AdvisorContextPhase = "final" | "progress";

export interface BuildAdvisorContextOptions {
  /** Conversation messages only. Do not pass the agent system prompt or loaded context files. */
  messages: readonly unknown[];
  candidate: string;
  maxChars?: number;
  phase?: AdvisorContextPhase;
}

export interface AdvisorContextResult {
  transcript: string;
  truncated: boolean;
  includedHistoryMessageCount: number;
  omittedHistoryMessageCount: number;
}

interface SerializedMessage {
  index: number;
  role: string;
  text: string;
}

const TRANSCRIPT_HEADING = "ADVISOR REVIEW TRANSCRIPT";
const FINAL_CANDIDATE_HEADING = "Candidate response:";
const PROGRESS_CANDIDATE_HEADING = "Current work checkpoint:";
const USER_HEADING = "Latest user request:";
const CONTEXT_HEADING = "Recent context (oldest to newest):";
const CONTENT_CLIP_MARKER = "\n[... content shortened ...]\n";

/**
 * Build a bounded, review-only transcript from conversation messages.
 *
 * The candidate and latest real user message have dedicated sections. Remaining
 * reviewable messages are selected newest-first until the character budget is
 * exhausted, then the selected messages are rendered oldest-to-newest so causal
 * relationships such as tool calls and their results remain clear. The helper
 * deliberately has no system-prompt input so callers cannot accidentally forward
 * pi's system prompt or loaded context files.
 */
export function buildAdvisorContext(options: BuildAdvisorContextOptions): AdvisorContextResult {
  const maxChars = normalizeMaxChars(options.maxChars);
  const serialized = options.messages.flatMap((message, index) => {
    const result = serializeMessage(message, index);
    return result ? [result] : [];
  });
  const latestUser = findLatestUser(serialized);
  const candidate = redactSensitiveText(options.candidate).trim();
  const candidateMessageIndex = findCandidateMessageIndex(serialized, candidate);
  const historyNewestFirst = serialized
    .filter(
      (message) => message.index !== latestUser?.index && message.index !== candidateMessageIndex,
    )
    .reverse();
  const userRequest = latestUser?.text.trim() ?? "[No genuine user request was found.]";
  const allHistory = historyNewestFirst.map(formatHistoryMessage);
  const candidateHeading =
    options.phase === "progress" ? PROGRESS_CANDIDATE_HEADING : FINAL_CANDIDATE_HEADING;
  const compose = (history: readonly string[], truncationMarker?: string): string =>
    composeTranscript(candidate, userRequest, history, truncationMarker, candidateHeading);
  const fullTranscript = compose(allHistory);

  if (fullTranscript.length <= maxChars) {
    return {
      transcript: fullTranscript,
      truncated: false,
      includedHistoryMessageCount: allHistory.length,
      omittedHistoryMessageCount: 0,
    };
  }

  const requiredWithMarker = compose([], ADVISOR_CONTEXT_TRUNCATION_MARKER);
  if (requiredWithMarker.length > maxChars) {
    return buildWithClippedRequiredContent(
      candidate,
      userRequest,
      allHistory.length,
      maxChars,
      candidateHeading,
    );
  }

  const included: string[] = [];
  for (const message of allHistory) {
    const next = compose([...included, message], ADVISOR_CONTEXT_TRUNCATION_MARKER);
    if (next.length <= maxChars) {
      included.push(message);
      continue;
    }

    const withoutPartial = compose(included, ADVISOR_CONTEXT_TRUNCATION_MARKER);
    const separatorLength = included.length === 0 ? 0 : 2;
    const available = maxChars - withoutPartial.length - separatorLength;
    if (available > CONTENT_CLIP_MARKER.length) {
      included.push(clipMiddle(message, available));
    }
    break;
  }

  return {
    transcript: compose(included, ADVISOR_CONTEXT_TRUNCATION_MARKER),
    truncated: true,
    includedHistoryMessageCount: included.length,
    omittedHistoryMessageCount: Math.max(0, allHistory.length - included.length),
  };
}

/** Convenience wrapper for callers that only need the serialized transcript. */
export function buildAdvisorTranscript(options: BuildAdvisorContextOptions): string {
  return buildAdvisorContext(options).transcript;
}

function buildWithClippedRequiredContent(
  candidate: string,
  userRequest: string,
  omittedHistoryMessageCount: number,
  maxChars: number,
  candidateHeading: string,
): AdvisorContextResult {
  const emptyRequired = composeTranscript(
    "",
    "",
    [],
    ADVISOR_CONTEXT_TRUNCATION_MARKER,
    candidateHeading,
  );
  if (emptyRequired.length >= maxChars) {
    return {
      transcript: emptyRequired.slice(0, maxChars),
      truncated: true,
      includedHistoryMessageCount: 0,
      omittedHistoryMessageCount,
    };
  }

  const available = maxChars - emptyRequired.length;
  let candidateBudget = Math.min(candidate.length, Math.ceil(available / 2));
  let userBudget = Math.min(userRequest.length, available - candidateBudget);
  let remaining = available - candidateBudget - userBudget;

  const candidateExtra = Math.min(remaining, candidate.length - candidateBudget);
  candidateBudget += candidateExtra;
  remaining -= candidateExtra;
  userBudget += Math.min(remaining, userRequest.length - userBudget);

  const transcript = composeTranscript(
    clipMiddle(candidate, candidateBudget),
    clipMiddle(userRequest, userBudget),
    [],
    ADVISOR_CONTEXT_TRUNCATION_MARKER,
    candidateHeading,
  );
  return {
    transcript: transcript.slice(0, maxChars),
    truncated: true,
    includedHistoryMessageCount: 0,
    omittedHistoryMessageCount,
  };
}

function composeTranscript(
  candidate: string,
  userRequest: string,
  historyNewestFirst: readonly string[],
  truncationMarker?: string,
  candidateHeading = FINAL_CANDIDATE_HEADING,
): string {
  const recentContext =
    historyNewestFirst.length > 0
      ? [...historyNewestFirst].reverse().join("\n\n")
      : "[No additional context.]";
  return [
    TRANSCRIPT_HEADING,
    candidateHeading,
    candidate,
    USER_HEADING,
    userRequest,
    CONTEXT_HEADING,
    recentContext,
    truncationMarker,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}

function serializeMessage<ValueInput>(
  value: ValueInput,
  index: number,
): SerializedMessage | undefined {
  const snapshot = snapshotDataRecord(value);
  if (!snapshot || !Predicate.isString(snapshot.role)) return undefined;

  switch (snapshot.role) {
    case "user":
      return withText(index, "user", serializeContent(snapshot.content, true));
    case "assistant":
      return withText(index, "assistant", serializeAssistantContent(snapshot.content));
    case "toolResult": {
      const toolName = nonEmptyString(snapshot.toolName) ?? "unknown tool";
      const errorSuffix = snapshot.isError === true ? ", error" : "";
      return withText(
        index,
        `tool result: ${toolName}${errorSuffix}`,
        serializeContent(snapshot.content, true),
      );
    }
    case "custom": {
      if (snapshot.customType === "advisor-review" || snapshot.display === false) return undefined;
      const customType = nonEmptyString(snapshot.customType) ?? "extension message";
      return withText(
        index,
        `extension context: ${customType}`,
        serializeContent(snapshot.content, true),
      );
    }
    case "bashExecution": {
      if (snapshot.excludeFromContext === true) return undefined;
      const command = nonEmptyString(snapshot.command);
      const output = Predicate.isString(snapshot.output) ? snapshot.output : "";
      const text = [command ? `$ ${command}` : undefined, output].filter(Boolean).join("\n");
      return withText(index, "shell execution", text);
    }
    case "branchSummary":
      return withText(index, "branch summary", nonEmptyString(snapshot.summary));
    case "compactionSummary":
      return withText(index, "conversation summary", nonEmptyString(snapshot.summary));
    default:
      return undefined;
  }
}

function withText(
  index: number,
  role: string,
  text: string | undefined,
): SerializedMessage | undefined {
  const normalized = text?.trim();
  return normalized
    ? { index, role: redactSensitiveText(role), text: redactSensitiveText(normalized) }
    : undefined;
}

function serializeAssistantContent<ContentInput>(content: ContentInput): string {
  if (!Array.isArray(content)) return serializeContent(content, false);
  return content
    .flatMap((part) => {
      if (!isRecord(part) || !Predicate.isString(part.type)) return [];
      if (part.type === "text" && Predicate.isString(part.text)) return [part.text];
      if (part.type === "thinking") {
        if (Predicate.isString(part.thinking) && part.thinking) {
          return [`[assistant thinking]\n${part.thinking}`];
        }
        if (Predicate.isString(part.signature) && part.signature) {
          return ["[assistant thinking was exposed only as an opaque/redacted signature]"];
        }
        return ["[assistant thinking was redacted or unavailable]"];
      }
      if (part.type !== "toolCall") return [];

      const name = nonEmptyString(part.name) ?? "unknown";
      const args = safeJson(part.arguments);
      return [`[tool call: ${name}${args ? ` ${args}` : ""}]`];
    })
    .join("\n");
}

function serializeContent<ContentInput>(content: ContentInput, includeImages: boolean): string {
  if (Predicate.isString(content)) return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!isRecord(part) || !Predicate.isString(part.type)) return [];
      if (part.type === "text" && Predicate.isString(part.text)) return [part.text];
      if (includeImages && part.type === "image") {
        const mimeType = nonEmptyString(part.mimeType);
        return [`[image${mimeType ? `: ${mimeType}` : ""} omitted]`];
      }
      return [];
    })
    .join("\n");
}

function safeJson<ValueInput>(value: ValueInput): string | undefined {
  if (value === undefined) return undefined;
  return stringifyRedactedObservation(value);
}

function findLatestUser(messages: readonly SerializedMessage[]): SerializedMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message;
  }
  return undefined;
}

function findCandidateMessageIndex(
  messages: readonly SerializedMessage[],
  candidate: string,
): number | undefined {
  const normalizedCandidate = normalizeComparable(candidate);
  if (!normalizedCandidate) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "assistant" &&
      normalizeComparable(message.text) === normalizedCandidate
    ) {
      return message.index;
    }
  }
  return undefined;
}

function normalizeComparable(value: string): string {
  return value.replaceAll("\r\n", "\n").trim();
}

function formatHistoryMessage(message: SerializedMessage): string {
  return `[${message.role}]\n${message.text}`;
}

function clipMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return "";
  if (maxChars <= CONTENT_CLIP_MARKER.length) return value.slice(0, maxChars);

  const remaining = maxChars - CONTENT_CLIP_MARKER.length;
  const headChars = Math.ceil(remaining * 0.6);
  const tailChars = remaining - headChars;
  return `${value.slice(0, headChars)}${CONTENT_CLIP_MARKER}${value.slice(-tailChars)}`;
}

function normalizeMaxChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_CONTEXT_CHARS;
  }
  return Math.floor(value);
}

function nonEmptyString<ValueInput>(value: ValueInput): string | undefined {
  if (!Predicate.isString(value)) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
