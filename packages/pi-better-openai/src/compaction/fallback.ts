import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import {
  estimateTokens,
  findCutPoint,
  findTurnStartIndex,
  prepareBranchEntries,
  sessionEntryToContextMessages,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { hasExactPrefix, reconstructOpenAIContext } from "./context.ts";

const FileDetails = Schema.Struct({
  readFiles: Schema.optional(Schema.Array(Schema.String)),
  modifiedFiles: Schema.optional(Schema.Array(Schema.String)),
});

/** Native preparation over repaired history, never retaining an owned checkpoint. */
export function prepareOpenAIFallback(
  branch: readonly SessionEntry[],
  original: SessionBeforeCompactEvent["preparation"],
  observedOmissions: readonly string[] = [],
): SessionBeforeCompactEvent["preparation"] | undefined {
  const restored = reconstructOpenAIContext(branch, observedOmissions);
  if (!restored) return undefined;
  // Pi snapshots its unfiltered session when persisting the ordinary result. We cannot
  // safely supersede repair if that would freeze obsolete legacy prompt/tool authority.
  const nativeSystem = getCurrentSystemMessage(restored.nativeMessages);
  const canonicalSystem = getCurrentSystemMessage(restored.messages);
  if (
    !hasExactPrefix(
      [nativeSystem ? { ...nativeSystem, timestamp: 0 } : null],
      [canonicalSystem ? { ...canonicalSystem, timestamp: 0 } : null],
    )
  )
    return undefined;
  // Native replay must not bring an observed retry omission back into the retained tail.
  const lastOmitted = branch.findLastIndex((entry) => restored.omittedEntryIds.includes(entry.id));
  const tailIds = new Set(
    branch
      .slice(Math.max(branch.indexOf(restored.checkpoint), lastOmitted) + 1)
      .map((entry) => entry.id),
  );
  const entries = restored.entries;
  const start = entries.findIndex((entry) => tailIds.has(entry.id));
  if (start < 0) return undefined;
  const cut = findCutPoint(entries, start, entries.length, original.settings.keepRecentTokens);
  const kept = entries[cut.firstKeptEntryIndex];
  if (!kept || !tailIds.has(kept.id)) return undefined;
  // findCutPoint returns start when there is no legal conversation boundary.
  const retainedMessageIndex = entries.findIndex(
    (entry, index) =>
      index >= cut.firstKeptEntryIndex &&
      sessionEntryToContextMessages(entry).some((message) => message.role !== "system"),
  );
  if (
    retainedMessageIndex < 0 ||
    sessionEntryToContextMessages(entries[retainedMessageIndex]!).some(
      (message) => message.role === "toolResult",
    )
  )
    return undefined;
  const summarized = entries.slice(0, cut.firstKeptEntryIndex);
  const previous = summarized.findLast((entry) => entry.type === "compaction");
  const turnStart = findTurnStartIndex(entries, retainedMessageIndex, 0);
  const isSplitTurn = turnStart >= 0 && turnStart < cut.firstKeptEntryIndex;
  const historyEnd = isSplitTurn ? turnStart : cut.firstKeptEntryIndex;
  const messages = (selected: SessionEntry[]) =>
    selected
      .flatMap(sessionEntryToContextMessages)
      .filter((message) => message.role !== "system" && message.role !== "compactionSummary");
  const messagesToSummarize = messages(entries.slice(0, historyEnd));
  const turnPrefixMessages = isSplitTurn
    ? messages(entries.slice(turnStart, cut.firstKeptEntryIndex))
    : [];
  if (!messagesToSummarize.length && !turnPrefixMessages.length) return undefined;
  const fileOps = prepareBranchEntries(summarized, 0).fileOps;
  const details =
    previous?.type === "compaction"
      ? Option.getOrUndefined(Schema.decodeUnknownOption(FileDetails)(previous.details))
      : undefined;
  for (const path of details?.readFiles ?? []) fileOps.read.add(path);
  for (const path of details?.modifiedFiles ?? []) fileOps.edited.add(path);
  const preparation: SessionBeforeCompactEvent["preparation"] = {
    firstKeptEntryId: kept.id,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn,
    tokensBefore: Math.max(
      original.tokensBefore,
      restored.messages.reduce((total, message) => total + estimateTokens(message), 0),
    ),
    fileOps,
    settings: original.settings,
  };
  if (previous?.type === "compaction") preparation.previousSummary = previous.summary;
  return preparation;
}
