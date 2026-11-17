import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import type { BackendTranscriptEvent } from "../backend/model.ts";
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
    const cursor = saved.at(-1)?.id;
    // A cursor the child doesn't know, such as an entry of an abandoned file, fails the request;
    // the child then sends everything.
    yield* transcript
      .watch(cursor, forward(saved))
      .pipe(
        Effect.catch((error) =>
          cursor === undefined ? Effect.fail(error) : transcript.watch(undefined, forward([])),
        ),
      );
  });
  return { watchTranscript };
}
