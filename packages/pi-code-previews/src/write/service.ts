import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFrozenProjection, type ProjectionError } from "pi-cosmic-core";
import { acquireProjectionOwnership } from "../shared/projection-ownership";
import {
  clearWriteProjection,
  publishWriteProjection,
  type CodePreviewBeforeWrite,
  type CodePreviewWriteSnapshot,
} from "./projection";

const MAX_BEFORE_WRITE_CACHE_ENTRIES = 64;

export class CodePreviewWriteService extends Context.Service<
  CodePreviewWriteService,
  {
    readonly rememberBeforeWrite: (
      toolCallId: string,
      before: CodePreviewBeforeWrite,
    ) => Effect.Effect<void, ProjectionError>;
  }
>()("pi-code-previews/write/service/CodePreviewWriteService") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const owner = yield* Effect.acquireRelease(
        Effect.sync(() => acquireProjectionOwnership("code-preview-write-projection")),
        (acquired) => Effect.sync(() => clearWriteProjection(acquired)),
      );
      const projection = yield* makeFrozenProjection<
        CodePreviewWriteSnapshot,
        CodePreviewWriteSnapshot
      >(
        { entries: [] },
        (state) => state,
        (snapshot) => publishWriteProjection(owner, snapshot),
      );
      return CodePreviewWriteService.of({
        rememberBeforeWrite: Effect.fn("CodePreviewWriteService.rememberBeforeWrite")(
          (toolCallId: string, before: CodePreviewBeforeWrite) =>
            projection.transition((current) => {
              const entries = current.entries.filter(([id]) => id !== toolCallId);
              if (before !== undefined) entries.push([toolCallId, before] as const);
              return Effect.succeed([
                undefined,
                { entries: entries.slice(-MAX_BEFORE_WRITE_CACHE_ENTRIES) },
              ] as const);
            }),
        ),
      });
    }),
  );
}
