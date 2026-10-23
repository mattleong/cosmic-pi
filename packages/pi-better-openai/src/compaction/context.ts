import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
  buildContextEntries,
  buildSessionProjection,
  sessionEntryToContextMessages,
  type ContextWithSystemEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Equal from "effect/Equal";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeOpenAICompactionDetails } from "./protocol.ts";

export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Json));
const asJson = Fn.flow(encodeJson, decodeJson);

export function hasExactPrefix(actual: readonly unknown[], expected: readonly unknown[]): boolean {
  return (
    actual.length >= expected.length &&
    Arr.every(expected, (item, index) => Equal.equals(asJson(item), asJson(actual[index])))
  );
}

export function latestOwnedCheckpoint(branch: readonly SessionEntry[]) {
  const entry = Option.getOrUndefined(Arr.findLast(branch, (item) => item.type === "compaction"));
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
    const last = Option.getOrUndefined(
      Arr.findLast(
        buildContextEntries([...branch]),
        (entry) => sessionEntryToContextMessages(entry).length > 0,
      ),
    );
    if (last && isRetryOmittable(last)) requested.add(last.id);
  }
  return Arr.filterMap(branch, (entry, index) =>
    isRetryOmittable(entry) &&
    (requested.has(entry.id) || (index <= checkpointIndex && persisted.has(entry.id)))
      ? Result.succeed(entry.id)
      : Result.failVoid,
  );
}

export function projectContextEntries(branch: readonly SessionEntry[]): SessionEntry[] {
  return Arr.flatMap(
    buildSessionProjection([...branch]).entries,
    ({ sourceEntry, messages }): SessionEntry[] => {
      if (sourceEntry.type === "message")
        return Arr.map(messages, (message) => ({ ...sourceEntry, message }));
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
    new Set(Arr.map(branch, (entry) => entry.id)).size !== branch.length ||
    Arr.some(branch, (entry, index) => entry.parentId !== (branch[index - 1]?.id ?? null))
  )
    throw new Error("Unable to reconstruct a complete session branch.");
  const unwrapped: SessionEntry[] = Arr.map(branch, (entry) =>
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
  const coveredIds = new Set(Arr.map(branch.slice(0, checkpointIndex + 1), (entry) => entry.id));
  const omittedEntryIds = retryOmissions(branch, observedOmissions);
  const omitted = new Set(omittedEntryIds);
  const persistedOmissions = new Set(retryOmissions(branch));
  const coverageChanged =
    Arr.some(omittedEntryIds, (id) => coveredIds.has(id) && !persistedOmissions.has(id)) ||
    Arr.some(
      branch.slice(checkpointIndex + 1),
      (entry) => entry.type === "context_edit" && coveredIds.has(entry.targetId),
    );
  const conversation = Arr.flatMap(visible, (entry): SessionEntry[] => {
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
    coveredEntries: [...snapshot, ...Arr.filter(conversation, (entry) => coveredIds.has(entry.id))],
    messages: Arr.flatMap(entries, sessionEntryToContextMessages),
  };
}

export function repairOpenAIContext(
  branch: readonly SessionEntry[],
  messages: ContextWithSystemEvent["messages"],
  observedOmissions: readonly string[] = [],
) {
  const nativeEntries = buildSessionProjection([...branch]).entries;
  const visibleIds = new Set(
    Arr.map(
      Arr.filter(nativeEntries, (entry) => entry.messages.length > 0),
      (entry) => entry.sourceEntry.id,
    ),
  );
  const omitted = new Set(
    Arr.filter(retryOmissions(branch, observedOmissions), (id) => !visibleIds.has(id)),
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
