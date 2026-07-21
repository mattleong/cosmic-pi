import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { makeFrozenProjection, type ProjectionError } from "pi-cosmic-core";
import type { CodePreviewBeforeWrite } from "./preview-execution";
import {
  clearWriteProjection,
  publishWriteProjection,
  type CodePreviewWriteSnapshot,
} from "./projection";

const MAX_BEFORE_WRITE_CACHE_ENTRIES = 64;
type PathLock = { readonly semaphore: Semaphore.Semaphore; users: number };
type WriteState = CodePreviewWriteSnapshot;

export interface CodePreviewWriteServiceShape {
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
  CodePreviewWriteServiceShape
>()("pi-code-previews/write/service/CodePreviewWriteService") {
  static readonly layer = Layer.effect(
    this,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const pathLocks = new Map<string, PathLock>();
        const coordination = yield* Semaphore.make(1);
        const projectionOwner = Symbol("code-preview-write-projection");
        const projection = yield* makeFrozenProjection<WriteState, CodePreviewWriteSnapshot>(
          { entries: [] },
          (state) => state,
          (snapshot) => publishWriteProjection(projectionOwner, snapshot),
        );

        const acquire = (path: string) =>
          coordination.withPermits(1)(
            Effect.gen(function* () {
              const existing = pathLocks.get(path);
              if (existing) {
                existing.users++;
                return existing;
              }
              const created = { semaphore: yield* Semaphore.make(1), users: 1 };
              pathLocks.set(path, created);
              return created;
            }),
          );
        const release = (path: string, lock: PathLock) =>
          coordination.withPermits(1)(
            Effect.sync(() => {
              lock.users--;
              if (lock.users === 0 && pathLocks.get(path) === lock) pathLocks.delete(path);
            }),
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
              acquire(path),
              (lock) => lock.semaphore.withPermits(1)(effect),
              (lock) => release(path, lock),
            ),
          cacheSize: projection.getState.pipe(Effect.map((state) => state.entries.length)),
        });
        return { service, pathLocks, projectionOwner };
      }),
      ({ pathLocks, projectionOwner }) =>
        Effect.sync(() => {
          pathLocks.clear();
          clearWriteProjection(projectionOwner);
        }),
    ).pipe(Effect.map(({ service }) => service)),
  );
}
