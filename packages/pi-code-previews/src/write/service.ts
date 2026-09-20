import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFrozenProjection, type ProjectionError } from "pi-cosmic-core";
import { acquireProjectionOwnership } from "../shared/projection-ownership";
import type { CodePreviewBeforeWrite } from "./preview-execution";
import {
  clearWriteProjection,
  publishWriteProjection,
  type CodePreviewWriteSnapshot,
} from "./projection";

const MAX_BEFORE_WRITE_CACHE_ENTRIES = 64;
type WriteState = CodePreviewWriteSnapshot;

export interface CodePreviewWriteServiceContract {
  readonly rememberBeforeWrite: (
    toolCallId: string,
    before: CodePreviewBeforeWrite,
  ) => Effect.Effect<void, ProjectionError>;
}

export class CodePreviewWriteService extends Context.Service<
  CodePreviewWriteService,
  CodePreviewWriteServiceContract
>()("pi-code-previews/write/service/CodePreviewWriteService") {
  static readonly layer = Layer.effect(
    this,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const projectionOwner = acquireProjectionOwnership("code-preview-write-projection");
        const projection = yield* makeFrozenProjection<WriteState, CodePreviewWriteSnapshot>(
          { entries: [] },
          (state) => state,
          (snapshot) => publishWriteProjection(projectionOwner, snapshot),
        );

        const rememberBeforeWrite = (toolCallId: string, before: CodePreviewBeforeWrite) =>
          projection.transition((current) => {
            const entries = current.entries.filter(([id]) => id !== toolCallId);
            if (before !== undefined) entries.push([toolCallId, before] as const);
            return Effect.succeed([
              undefined,
              { entries: entries.slice(-MAX_BEFORE_WRITE_CACHE_ENTRIES) },
            ] as const);
          });

        const service = CodePreviewWriteService.of({
          rememberBeforeWrite,
        });
        return { service, projectionOwner };
      }),
      ({ projectionOwner }) => Effect.sync(() => clearWriteProjection(projectionOwner)),
    ).pipe(Effect.map(({ service }) => service)),
  );
}
