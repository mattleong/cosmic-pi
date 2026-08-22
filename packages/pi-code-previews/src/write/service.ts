import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as RcMap from "effect/RcMap";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
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
  readonly acknowledgeBeforeWrite: (
    toolCallId: string,
  ) => Effect.Effect<CodePreviewBeforeWrite, ProjectionError>;
  readonly withPathLock: <A, E, R>(
    path: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly cacheSize: Effect.Effect<number>;
}

export class CodePreviewWriteService extends Context.Service<
  CodePreviewWriteService,
  CodePreviewWriteServiceContract
>()("pi-code-previews/write/service/CodePreviewWriteService") {
  static readonly layer = Layer.effect(
    this,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const pathLocks = yield* RcMap.make({
          lookup: (_path: string) => Semaphore.make(1),
          idleTimeToLive: Duration.zero,
        });
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

        const acknowledgeBeforeWrite = (toolCallId: string) =>
          projection.transition((current) => {
            const before = current.entries.find(([id]) => id === toolCallId)?.[1];
            return Effect.succeed([
              before,
              { entries: current.entries.filter(([id]) => id !== toolCallId) },
            ] as const);
          });

        const service = CodePreviewWriteService.of({
          rememberBeforeWrite,
          acknowledgeBeforeWrite,
          withPathLock: (path, effect) =>
            Effect.acquireUseRelease(
              Scope.make(),
              (leaseScope) =>
                RcMap.get(pathLocks, path).pipe(
                  Effect.provideService(Scope.Scope, leaseScope),
                  Effect.flatMap((lock) => lock.withPermit(effect)),
                ),
              (leaseScope) => Scope.close(leaseScope, Exit.void),
            ),
          cacheSize: projection.getState.pipe(Effect.map((state) => state.entries.length)),
        });
        return { service, projectionOwner };
      }),
      ({ projectionOwner }) => Effect.sync(() => clearWriteProjection(projectionOwner)),
    ).pipe(Effect.map(({ service }) => service)),
  );
}
