import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { childCommand, splitDirection, type ChildLaunch, type RexLocation } from "./launch.ts";
import { GitBranch } from "./git.ts";
import { RexClient } from "./rex.ts";

export interface RexBtwInput {
  readonly cwd: string;
  readonly extensionPath: string;
  readonly shell: string | undefined;
  readonly location: RexLocation;
}

export type BtwRequest = Omit<ChildLaunch, "cwd" | "shell" | "extensionPath" | "branch">;

const makeRexBtw = Effect.fn("RexBtw.make")(function* (input: RexBtwInput) {
  const rex = yield* RexClient;
  const currentBranch = yield* GitBranch;
  // Only the newest pane is remembered so later panes stack beside it instead of shrinking the
  // caller. Nothing is persisted: closing or forgetting a pane needs no cleanup.
  const lastBlock = yield* Ref.make<string | undefined>(undefined);
  const gate = yield* Semaphore.make(1);

  const splitBeside = Effect.fn("RexBtw.splitBeside")(function* (
    anchorBlockId: string,
    request: BtwRequest,
  ) {
    const anchor = { sessionId: input.location.sessionId, blockId: anchorBlockId };
    const columns = yield* rex.paneColumns(anchor);
    // Read per command because the user may switch branches during the session.
    const branch = yield* currentBranch(input.cwd);
    const blockId = yield* rex.split({
      sessionId: anchor.sessionId,
      anchorBlockId,
      direction: splitDirection(columns),
      cwd: input.cwd,
      command: childCommand({
        ...request,
        cwd: input.cwd,
        branch,
        shell: input.shell,
        extensionPath: input.extensionPath,
      }),
    });
    yield* Ref.set(lastBlock, blockId);
    return blockId;
  });

  const open = Effect.fn("RexBtw.open")(function* (request: BtwRequest) {
    const previous = yield* Ref.get(lastBlock);
    if (previous === undefined) return yield* splitBeside(input.location.blockId, request);
    return yield* splitBeside(previous, request).pipe(
      Effect.catchIf(
        (error) => error.reason === "anchorMissing",
        () =>
          Ref.set(lastBlock, undefined).pipe(
            Effect.andThen(splitBeside(input.location.blockId, request)),
          ),
      ),
    );
  });

  return { open: (request: BtwRequest) => gate.withPermit(open(request)) };
});

export class RexBtw extends Context.Service<RexBtw>()("pi-rex-btw/btw/RexBtw", {
  make: makeRexBtw,
}) {
  static readonly layer = (input: RexBtwInput) => Layer.effect(this, makeRexBtw(input));
}
