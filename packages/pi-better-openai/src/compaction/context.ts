import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
  buildContextEntries,
  buildSessionProjection,
  sessionEntryToContextMessages,
  type ContextWithSystemEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { decodeOpenAICompactionDetails } from "./protocol.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Json));
type ComparableJson = Schema.Json;

function ordered(value: ComparableJson): ComparableJson {
  if (
    value === null ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  )
    return value;
  if (Array.isArray(value)) return value.map(ordered);
  return Object.fromEntries(
    Object.entries<ComparableJson>(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, ordered(item)]),
  );
}

export function hasExactPrefix(actual: readonly unknown[], expected: readonly unknown[]): boolean {
  return (
    actual.length >= expected.length &&
    expected.every(
      (item, index) =>
        encode(ordered(decodeJson(encode(item)))) ===
        encode(ordered(decodeJson(encode(actual[index])))),
    )
  );
}

export function latestOwnedCompaction(branch: readonly SessionEntry[]) {
  const latest = branch.findLast((entry) => entry.type === "compaction");
  return latest?.type === "compaction" && decodeOpenAICompactionDetails(latest.details)
    ? latest
    : undefined;
}

export function isRetryOmittable(entry: SessionEntry): boolean {
  return (
    entry.type === "message" &&
    entry.message.role === "assistant" &&
    (entry.message.stopReason === "error" || entry.message.stopReason === "length")
  );
}

/** Omission metadata never authorizes dropping users, tools, systems, or successful responses. */
export function retryOmissions(
  branch: readonly SessionEntry[],
  observed: readonly string[] = [],
  willRetry = false,
): string[] {
  const checkpoint = latestOwnedCompaction(branch);
  const checkpointIndex = checkpoint ? branch.indexOf(checkpoint) : -1;
  const persisted = new Set(
    checkpoint ? decodeOpenAICompactionDetails(checkpoint.details)?.checkpoint.omittedEntryIds : [],
  );
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

/** Materialize Pi's edited contributions without changing persisted entries or their IDs. */
export function projectContextEntries(branch: readonly SessionEntry[]): SessionEntry[] {
  return buildSessionProjection([...branch]).entries.flatMap(
    ({ sourceEntry, messages }): SessionEntry[] => {
      if (sourceEntry.type === "message")
        return messages.map((message) => ({ ...sourceEntry, message }));
      if (sourceEntry.type === "custom_message") {
        const message = messages[0];
        return message?.role === "custom" ? [{ ...sourceEntry, content: message.content }] : [];
      }
      // Retained older compactions are raw anchors, not additional summaries/snapshots.
      if (sourceEntry.type === "compaction" && !messages.length) return [];
      return [sourceEntry];
    },
  );
}

/** Restore conversation without replaying superseded system snapshots or ordinary summaries. */
export function reconstructOpenAIContext(
  branch: readonly SessionEntry[],
  observedOmissions: readonly string[] = [],
) {
  const checkpoint = latestOwnedCompaction(branch);
  if (!checkpoint) return undefined;
  const checkpointIndex = branch.indexOf(checkpoint);
  if (
    new Set(branch.map((entry) => entry.id)).size !== branch.length ||
    branch.some((entry, index) => entry.parentId !== (branch[index - 1]?.id ?? null))
  )
    throw new Error("Unable to reconstruct a complete session branch.");
  // Preserve every parent anchor. These inert clones never enter the persisted transcript.
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
  // Old v1 snapshots may already contain replayed obsolete snapshots, or be absent.
  // Fold the original prompt updates with Pi's public reducer instead of trusting them.
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
    nativeMessages: buildSessionProjection([...branch]).messages,
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
  // A tree restore can legitimately put an old failed response back in native context.
  const omitted = new Set(
    retryOmissions(branch, observedOmissions).filter((id) => !visibleIds.has(id)),
  );
  let cursor = 0;
  for (const { sourceEntry: entry, messages: projected } of nativeEntries) {
    for (const expected of projected) {
      if (cursor < messages.length && hasExactPrefix([messages[cursor]], [expected])) cursor++;
      else if (isRetryOmittable(entry)) omitted.add(entry.id);
      else {
        if (!latestOwnedCompaction(branch)) return undefined;
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
