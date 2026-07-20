import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type { CodePreviewBeforeWrite } from "./preview-execution";

const MAX_BEFORE_WRITE_CACHE_ENTRIES = 64;
type PathLock = { readonly semaphore: Semaphore.Semaphore; users: number };

export interface CodePreviewWriteServiceShape {
  readonly takeBeforeWrite: (toolCallId: string) => CodePreviewBeforeWrite;
  readonly rememberBeforeWrite: (toolCallId: string, before: CodePreviewBeforeWrite) => void;
  readonly withPathLock: <A, E, R>(
    path: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly cacheSize: () => number;
}

let activeWriteProjection: CodePreviewWriteServiceShape | undefined;

export function writeServiceProjection(): CodePreviewWriteServiceShape | undefined {
  return activeWriteProjection;
}

export class CodePreviewWriteService extends Context.Service<
  CodePreviewWriteService,
  CodePreviewWriteServiceShape
>()("pi-code-previews/write/service/CodePreviewWriteService") {
  static readonly layer = Layer.effect(
    this,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const beforeWriteCache = new Map<string, CodePreviewBeforeWrite>();
        const pathLocks = new Map<string, PathLock>();
        const coordination = yield* Semaphore.make(1);

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

        const service = CodePreviewWriteService.of({
          takeBeforeWrite: (toolCallId) => {
            const before = beforeWriteCache.get(toolCallId);
            beforeWriteCache.delete(toolCallId);
            return before;
          },
          rememberBeforeWrite: (toolCallId, before) => {
            beforeWriteCache.delete(toolCallId);
            if (before !== undefined) beforeWriteCache.set(toolCallId, before);
            while (beforeWriteCache.size > MAX_BEFORE_WRITE_CACHE_ENTRIES) {
              const oldest = beforeWriteCache.keys().next().value;
              if (oldest === undefined) break;
              beforeWriteCache.delete(oldest);
            }
          },
          withPathLock: (path, effect) =>
            Effect.acquireUseRelease(
              acquire(path),
              (lock) => lock.semaphore.withPermits(1)(effect),
              (lock) => release(path, lock),
            ),
          cacheSize: () => beforeWriteCache.size,
        });
        activeWriteProjection = service;
        return { service, beforeWriteCache, pathLocks };
      }),
      ({ service, beforeWriteCache, pathLocks }) =>
        Effect.sync(() => {
          beforeWriteCache.clear();
          pathLocks.clear();
          if (activeWriteProjection === service) activeWriteProjection = undefined;
        }),
    ).pipe(Effect.map(({ service }) => service)),
  );
}
