import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
  buildSessionProjection,
  estimateTokens,
  findCutPoint,
  findTurnStartIndex,
  prepareBranchEntries,
  sessionEntryToContextMessages,
  type CompactionEntry,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined } from "pi-cosmic-core";
import { hasExactPrefix, reconstructOpenAIContext } from "./context.ts";

const FileDetails = Schema.Struct({
  readFiles: Schema.optional(Schema.Array(Schema.String)),
  modifiedFiles: Schema.optional(Schema.Array(Schema.String)),
});

type RestoredContext = NonNullable<ReturnType<typeof reconstructOpenAIContext>>;

const timelessSystem = (messages: Parameters<typeof getCurrentSystemMessage>[0]) => {
  const system = getCurrentSystemMessage(messages);
  return system ? { ...system, timestamp: 0 } : null;
};

const nativeSystemMatches = (branch: readonly SessionEntry[], restored: RestoredContext) =>
  hasExactPrefix(
    [timelessSystem(buildSessionProjection([...branch]).messages)],
    [timelessSystem(restored.messages)],
  );

const retainableTailIds = (branch: readonly SessionEntry[], restored: RestoredContext) => {
  const lastOmitted = Option.getOrElse(
    Arr.findLastIndex(branch, (entry) => restored.omittedEntryIds.includes(entry.id)),
    () => -1,
  );
  return new Set(
    Arr.map(
      branch.slice(Math.max(branch.indexOf(restored.checkpoint), lastOmitted) + 1),
      (entry) => entry.id,
    ),
  );
};

const firstRetainedMessageIndex = (entries: readonly SessionEntry[], firstKept: number) => {
  const index = Option.getOrElse(
    Arr.findFirstIndex(
      entries,
      (entry, position) =>
        position >= firstKept &&
        Arr.some(sessionEntryToContextMessages(entry), (message) => message.role !== "system"),
    ),
    () => -1,
  );
  const retained = entries[index];
  return retained &&
    !Arr.some(sessionEntryToContextMessages(retained), (message) => message.role === "toolResult")
    ? index
    : undefined;
};

const summaryMessages = (selected: readonly SessionEntry[]) =>
  Arr.filter(
    Arr.flatMap(selected, sessionEntryToContextMessages),
    (message) => message.role !== "system" && message.role !== "compactionSummary",
  );

const decodeFileDetails = decodeUnknownOrUndefined(FileDetails);

const summarizedFileOps = (
  summarized: readonly SessionEntry[],
  previous: CompactionEntry | undefined,
) => {
  const fileOps = prepareBranchEntries([...summarized], 0).fileOps;
  const details = previous && decodeFileDetails(previous.details);
  for (const path of details?.readFiles ?? []) fileOps.read.add(path);
  for (const path of details?.modifiedFiles ?? []) fileOps.edited.add(path);
  return fileOps;
};

export function prepareOpenAIFallback(
  branch: readonly SessionEntry[],
  original: SessionBeforeCompactEvent["preparation"],
  observedOmissions: readonly string[] = [],
): SessionBeforeCompactEvent["preparation"] | undefined {
  const restored = reconstructOpenAIContext(branch, observedOmissions);
  if (!restored || !nativeSystemMatches(branch, restored)) return undefined;
  const tailIds = retainableTailIds(branch, restored);
  const entries = restored.entries;
  const start = Option.getOrElse(
    Arr.findFirstIndex(entries, (entry) => tailIds.has(entry.id)),
    () => -1,
  );
  if (start < 0) return undefined;
  const cut = findCutPoint(entries, start, entries.length, original.settings.keepRecentTokens);
  const kept = entries[cut.firstKeptEntryIndex];
  if (!kept || !tailIds.has(kept.id)) return undefined;
  const retainedMessageIndex = firstRetainedMessageIndex(entries, cut.firstKeptEntryIndex);
  if (retainedMessageIndex === undefined) return undefined;
  const summarized = entries.slice(0, cut.firstKeptEntryIndex);
  const previous = Option.getOrUndefined(
    Arr.findLast(summarized, (entry) => entry.type === "compaction"),
  );
  const turnStart = findTurnStartIndex(entries, retainedMessageIndex, 0);
  const isSplitTurn = turnStart >= 0 && turnStart < cut.firstKeptEntryIndex;
  const messagesToSummarize = summaryMessages(
    entries.slice(0, isSplitTurn ? turnStart : cut.firstKeptEntryIndex),
  );
  const turnPrefixMessages = isSplitTurn
    ? summaryMessages(entries.slice(turnStart, cut.firstKeptEntryIndex))
    : [];
  if (!messagesToSummarize.length && !turnPrefixMessages.length) return undefined;
  return {
    firstKeptEntryId: kept.id,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn,
    tokensBefore: Math.max(
      original.tokensBefore,
      Arr.reduce(restored.messages, 0, (total, message) => total + estimateTokens(message)),
    ),
    fileOps: summarizedFileOps(summarized, previous),
    settings: original.settings,
    ...(previous && { previousSummary: previous.summary }),
  };
}
