import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
  buildContextEntries,
  buildSessionProjection,
  sessionEntryToContextMessages,
  type CompactionEntry,
  type ContextWithSystemEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import { decodeOpenAICompactionDetails } from "./protocol.ts";

export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Json));
const asJson = <Value>(value: Value) => decodeJson(encodeJson(value));

export function hasExactPrefix(actual: readonly unknown[], expected: readonly unknown[]): boolean {
  return (
    actual.length >= expected.length &&
    expected.every((item, index) => Equal.equals(asJson(item), asJson(actual[index])))
  );
}

export function latestOwnedCheckpoint(branch: readonly SessionEntry[]) {
  const entry = branch.findLast((item): item is CompactionEntry => item.type === "compaction");
  const details = entry && decodeOpenAICompactionDetails(entry.details);
  return entry && details ? { entry, checkpoint: details.checkpoint } : undefined;
}

export function isRetryOmittable(entry: SessionEntry): boolean {
  return (
    entry.type === "message" &&
    entry.message.role === "assistant" &&
    (entry.message.stopReason === "error" || entry.message.stopReason === "length")
  );
}

export function retryOmissions(
  branch: readonly SessionEntry[],
  observed: readonly string[] = [],
  willRetry = false,
): string[] {
  const owned = latestOwnedCheckpoint(branch);
  const checkpointIndex = owned ? branch.indexOf(owned.entry) : -1;
  const persisted = new Set(owned?.checkpoint.omittedEntryIds);
  const requested = new Set(observed);
  if (willRetry) {
    const last = buildContextEntries([...branch]).findLast(
      (entry) => sessionEntryToContextMessages(entry).length > 0,
    );
    if (last && isRetryOmittable(last)) requested.add(last.id);
  }
  return branch
    .filter(
      (entry, index) =>
        isRetryOmittable(entry) &&
        (requested.has(entry.id) || (index <= checkpointIndex && persisted.has(entry.id))),
    )
    .map((entry) => entry.id);
}

export function projectContextEntries(branch: readonly SessionEntry[]): SessionEntry[] {
  return buildSessionProjection([...branch]).entries.flatMap(
    ({ sourceEntry, messages }): SessionEntry[] => {
      if (sourceEntry.type === "message")
        return messages.map((message) => ({ ...sourceEntry, message }));
      if (sourceEntry.type === "custom_message") {
        const message = messages[0];
        return message?.role === "custom" ? [{ ...sourceEntry, content: message.content }] : [];
      }
      if (sourceEntry.type === "compaction" && !messages.length) return [];
      return [sourceEntry];
    },
  );
}

export function reconstructOpenAIContext(
  branch: readonly SessionEntry[],
  observedOmissions: readonly string[] = [],
) {
  const checkpoint = latestOwnedCheckpoint(branch)?.entry;
  if (!checkpoint) return undefined;
  const checkpointIndex = branch.indexOf(checkpoint);
  if (
    new Set(branch.map((entry) => entry.id)).size !== branch.length ||
    branch.some((entry, index) => entry.parentId !== (branch[index - 1]?.id ?? null))
  )
    throw new Error("Unable to reconstruct a complete session branch.");
  const unwrapped: SessionEntry[] = branch.map((entry) =>
    entry.type === "compaction" && decodeOpenAICompactionDetails(entry.details)
      ? {
          type: "custom",
          id: entry.id,
          parentId: entry.parentId,
          timestamp: entry.timestamp,
          customType: "openai-compaction-anchor",
          data: undefined,
        }
      : entry,
  );
  const visible = projectContextEntries(unwrapped);
  const coveredIds = new Set(branch.slice(0, checkpointIndex + 1).map((entry) => entry.id));
  const omittedEntryIds = retryOmissions(branch, observedOmissions);
  const omitted = new Set(omittedEntryIds);
  const persistedOmissions = new Set(retryOmissions(branch));
  const coverageChanged =
    omittedEntryIds.some((id) => coveredIds.has(id) && !persistedOmissions.has(id)) ||
    branch
      .slice(checkpointIndex + 1)
      .some((entry) => entry.type === "context_edit" && coveredIds.has(entry.targetId));
  const conversation = visible.flatMap((entry): SessionEntry[] => {
    if (omitted.has(entry.id)) return [];
    if (!coveredIds.has(entry.id)) return [entry];
    if (entry.type === "message" && entry.message.role === "system") return [];
    if (entry.type === "compaction") {
      const { systemMessage: _snapshot, ...summary } = entry;
      return [summary];
    }
    return [entry];
  });
  const systemMessage = getCurrentSystemMessage(
    buildSessionProjection(unwrapped.slice(0, checkpointIndex + 1)).messages,
  );
  const snapshot: SessionEntry[] = systemMessage
    ? [
        {
          type: "message",
          id: `${checkpoint.id}-system`,
          parentId: null,
          timestamp: checkpoint.timestamp,
          message: systemMessage,
        },
      ]
    : [];
  const entries = [...snapshot, ...conversation];
  return {
    checkpoint,
    omittedEntryIds,
    coverageChanged,
    entries,
    coveredEntries: [...snapshot, ...conversation.filter((entry) => coveredIds.has(entry.id))],
    messages: entries.flatMap(sessionEntryToContextMessages),
  };
}

export function repairOpenAIContext(
  branch: readonly SessionEntry[],
  messages: ContextWithSystemEvent["messages"],
  observedOmissions: readonly string[] = [],
) {
  const nativeEntries = buildSessionProjection([...branch]).entries;
  const visibleIds = new Set(
    nativeEntries.filter((entry) => entry.messages.length).map((entry) => entry.sourceEntry.id),
  );
  const omitted = new Set(
    retryOmissions(branch, observedOmissions).filter((id) => !visibleIds.has(id)),
  );
  let cursor = 0;
  for (const { sourceEntry: entry, messages: projected } of nativeEntries) {
    for (const expected of projected) {
      if (cursor < messages.length && hasExactPrefix([messages[cursor]], [expected])) cursor++;
      else if (isRetryOmittable(entry)) omitted.add(entry.id);
      else {
        if (!latestOwnedCheckpoint(branch)) return undefined;
        throw new Error("Unable to identify the native session context prefix.");
      }
    }
  }
  const omittedEntryIds = [...omitted];
  const restored = reconstructOpenAIContext(branch, omittedEntryIds);
  return {
    omittedEntryIds,
    messages: restored ? [...restored.messages, ...messages.slice(cursor)] : undefined,
  };
}
