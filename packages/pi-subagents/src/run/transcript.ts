import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { TRANSCRIPT_REPLY_OVERSIZED, type BackendTranscriptEvent } from "../backend/model.ts";
import {
  readSessionEntries,
  sessionEntriesReply,
  transcriptMessages,
  type TranscriptMessage,
} from "../boundary/session-transcript.ts";
import type { SubagentError } from "./errors.ts";
import type { RunContext } from "./internal.ts";

/**
 * What a transcript view receives: the conversation so far, then each event of the run's process
 * as the child emitted it. `live` is false for a run without a process, whose conversation only
 * changes once it is resumed. After a `gap`, only a new watch is complete again.
 */
export type SubagentTranscriptEvent =
  | {
      readonly type: "snapshot";
      readonly messages: ReadonlyArray<TranscriptMessage>;
      readonly live: boolean;
    }
  | { readonly type: "event"; readonly value: Schema.Json }
  | { readonly type: "gap" };

export type SubagentTranscriptListener = (event: SubagentTranscriptEvent) => void;

/** How many times one watch rereads the session file after the child's reply was too large. */
const MAX_RESNAPSHOTS = 2;

const isTranscriptReplyOversized = (error: SubagentError): boolean =>
  Predicate.isTagged(error, "SubagentProcessError") && error.code === TRANSCRIPT_REPLY_OVERSIZED;

export function transcriptOperations(dependencies: Pick<RunContext, "requireRecord" | "withLock">) {
  const { requireRecord, withLock } = dependencies;
  /**
   * Shows `listener` the run's conversation until the scope closes. It reads the session file for
   * the history, then asks the live process only for what the file doesn't hold yet, so a long
   * conversation never has to fit in one reply; the process answers and its later events arrive in
   * one order. Watching never changes the run, and a run whose process is replaced, as a resume
   * does, needs a new watch.
   */
  const watchTranscript = Effect.fn("SubagentTranscript.watch")(function* (
    id: string,
    listener: SubagentTranscriptListener,
  ): Effect.fn.Return<void, SubagentError, Scope.Scope> {
    const { transcript, sessionFile } = yield* withLock(
      Effect.map(requireRecord(id), (record) => ({
        transcript: record.process?.transcript,
        sessionFile: record.view.sessionFile,
      })),
    );
    const saved = sessionFile === undefined ? [] : yield* readSessionEntries(sessionFile);
    const tell = (event: SubagentTranscriptEvent) =>
      invokeHostCallback(() => listener(event), undefined);
    if (!transcript) {
      tell({ type: "snapshot", messages: transcriptMessages(saved, undefined), live: false });
      return;
    }
    const forward =
      (history: typeof saved) =>
      (event: BackendTranscriptEvent): void => {
        if (event.type !== "entries") return tell(event);
        const reply = sessionEntriesReply(event.data);
        tell({
          type: "snapshot",
          messages: transcriptMessages([...history, ...reply.entries], reply.leafId),
          live: true,
        });
      };
    const watchAfter = (
      history: typeof saved,
      resnapshots: number,
    ): Effect.Effect<void, SubagentError, Scope.Scope> => {
      const cursor = history.at(-1)?.id;
      return transcript.watch(cursor, forward(history)).pipe(
        Effect.catch((error) => {
          // Entries too large for one reply are what the file holds by now, and everything would
          // be larger still, so the watch rereads the file and asks only past its new end.
          if (isTranscriptReplyOversized(error))
            return resnapshots >= MAX_RESNAPSHOTS || sessionFile === undefined
              ? Effect.fail(error)
              : readSessionEntries(sessionFile).pipe(
                  Effect.flatMap((latest) => {
                    const advanced = latest.at(-1)?.id;
                    return advanced === undefined || advanced === cursor
                      ? Effect.fail(error)
                      : watchAfter(latest, resnapshots + 1);
                  }),
                );
          // A cursor the child doesn't know, such as an entry of an abandoned file, fails the
          // request; the child then sends everything, unless a reply has already been too large.
          return cursor === undefined || resnapshots > 0
            ? Effect.fail(error)
            : transcript.watch(undefined, forward([]));
        }),
      );
    };
    yield* watchAfter(saved, 0);
  });
  return { watchTranscript };
}
