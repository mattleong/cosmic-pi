import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { nodeFsConstants, nodeFsPromises } from "pi-cosmic-core/platform/node-builtins";
import { parentConversation, type ParentConversation } from "./transcript.ts";
import type { ParentReference } from "../launch.ts";

/** The end of the parent's session file one read examines; older entries need another tool. */
const READ_WINDOW_BYTES = 16 * 1024 * 1024;

/** Why the parent conversation couldn't be read: its file is gone, or it can't be read safely. */
export class ParentTranscriptError extends Schema.TaggedError<
  ParentTranscriptError,
  { readonly brand: unique symbol }
>()("ParentTranscriptError", { reason: Schema.Literals(["missing", "unreadable"]) }) {}

const isMissing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));

const attempt = <A>(evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      ParentTranscriptError.make({ reason: isMissing(cause) ? "missing" : "unreadable" }),
  });

type OpenedFile = Awaited<ReturnType<typeof nodeFsPromises.open>>;

const readWindow = Effect.fnUntraced(function* (handle: OpenedFile) {
  const stat = yield* attempt(() => handle.stat());
  if (!stat.isFile()) return yield* ParentTranscriptError.make({ reason: "unreadable" });
  const start = Math.max(0, stat.size - READ_WINDOW_BYTES);
  const bytes = new Uint8Array(stat.size - start);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = yield* attempt(() =>
      handle.read({
        buffer: bytes,
        offset,
        length: bytes.byteLength - offset,
        position: start + offset,
      }),
    );
    // The file shrank while it was read; what was read is still a valid window.
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return { text: new TextDecoder().decode(bytes.subarray(0, offset)), truncated: start > 0 };
});

export interface ParentTranscriptContract {
  /** The latest `messages` on the parent's current branch, read without following a final link. */
  readonly read: (
    parent: ParentReference,
    messages: number,
  ) => Effect.Effect<ParentConversation, ParentTranscriptError>;
}

export class ParentTranscript extends Context.Service<ParentTranscript, ParentTranscriptContract>()(
  "pi-rex-btw/parent/reader/ParentTranscript",
) {
  static readonly layer = Layer.succeed(
    this,
    ParentTranscript.of({
      read: Effect.fn("ParentTranscript.read")(function* (parent, messages) {
        const window = yield* Effect.acquireUseRelease(
          attempt(() =>
            nodeFsPromises.open(
              parent.path,
              nodeFsConstants.O_RDONLY | nodeFsConstants.O_NONBLOCK | nodeFsConstants.O_NOFOLLOW,
            ),
          ),
          readWindow,
          (handle) => attempt(() => handle.close()).pipe(Effect.ignore),
        );
        return parentConversation(parent.id, window.text, window.truncated, messages);
      }),
    }),
  );
}
