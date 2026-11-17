import {
  buildSessionContext,
  parseSessionEntries,
  type SessionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { nodeFsPromises } from "pi-cosmic-core/platform/node-builtins";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";

/** A conversation message as Pi's own session reader types it. */
export type TranscriptMessage = SessionContext["messages"][number];

const sessionEntries = (content: string): ReadonlyArray<SessionEntry> =>
  Arr.filter(
    parseSessionEntries(content),
    (entry): entry is SessionEntry => entry.type !== "session",
  );

/**
 * The entries a run's session file holds now. Pi appends whole lines, and its reader skips a line
 * it can't parse, so a file read mid-append is just short. A missing or unreadable file reads as
 * empty: the run hasn't written one yet, or its state was reclaimed.
 */
export const readSessionEntries = (
  sessionFile: string,
): Effect.Effect<ReadonlyArray<SessionEntry>> =>
  Effect.tryPromise(() => nodeFsPromises.readFile(sessionFile, "utf8")).pipe(
    Effect.flatMap((content) => Effect.try(() => sessionEntries(content))),
    Effect.orElseSucceed((): ReadonlyArray<SessionEntry> => []),
  );

const EntriesReplySchema = Schema.Struct({
  entries: Schema.Array(Schema.Json),
  leafId: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeEntriesReply = decodeUnknownOrUndefined(EntriesReplySchema);
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

export interface SessionEntriesReply {
  readonly entries: ReadonlyArray<SessionEntry>;
  /** The child's active leaf; `undefined` when the reply didn't say. */
  readonly leafId: string | null | undefined;
}

/**
 * A child's `get_entries` reply, read by Pi's own session reader so its entries have Pi's types.
 * An unreadable reply holds no entries.
 */
export const sessionEntriesReply = (data: Schema.Json | undefined): SessionEntriesReply => {
  const reply = decodeEntriesReply(data);
  if (!reply) return { entries: [], leafId: undefined };
  const lines = Arr.join(
    Arr.map(reply.entries, (entry) => encodeJsonLine(entry)),
    "\n",
  );
  return { entries: sessionEntries(lines), leafId: reply.leafId };
};

/** The messages of the branch ending at `leafId`, or at the last entry without one. */
export const transcriptMessages = (
  entries: ReadonlyArray<SessionEntry>,
  leafId: string | null | undefined,
): ReadonlyArray<TranscriptMessage> =>
  buildSessionContext([...entries], leafId ?? entries.at(-1)?.id ?? null).messages;

/**
 * One message from a child's live event, read as Pi's session reader reads a saved message.
 * Pi's reader types what it parses without checking it, so a caller draws the result defensively.
 */
export const transcriptMessage = (message: Schema.Json): TranscriptMessage | undefined => {
  const [entry] = sessionEntries(
    encodeJsonLine({ type: "message", id: "live", parentId: null, timestamp: "", message }),
  );
  return entry?.type === "message" ? entry.message : undefined;
};
