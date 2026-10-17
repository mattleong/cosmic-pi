import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  type WriterLeaseContract,
  WriterLeaseService,
} from "../../../src/boundary/writer-lease.ts";
import {
  WorkspaceError,
  type UnavailableWorkspaceArtifact,
  type WorkspaceIntegrationTarget,
  type WorkspaceRecord,
  type WorkspaceTarget,
} from "../../../src/workspace/model.ts";
import { WorkspaceService, type WorkspaceServiceContract } from "../../../src/workspace/service.ts";
import type { StartSubagentRequest } from "../../../src/run/model.ts";
import type { SubagentServiceContract, SubagentServiceOptions } from "../../../src/run/service.ts";
import {
  fakeChildLayer,
  fakeWriterLeaseLayer,
  type profileLayerFor,
  request,
  serviceLayer,
} from "./service-harness.ts";

export const repoWriter = (overrides: Partial<StartSubagentRequest> = {}) =>
  request({ cwd: "/repo", writeIntent: "writer", ...overrides });

export const stoppedWriter = (
  service: SubagentServiceContract,
  overrides?: Partial<StartSubagentRequest>,
) => service.start(repoWriter(overrides)).pipe(Effect.tap((run) => service.stop(run.id)));

export const reviewAndPrepare = (service: SubagentServiceContract, workspaceId: string) =>
  Effect.gen(function* () {
    const first = yield* service.workspaceReview(workspaceId);
    yield* service.workspaceReview(workspaceId, {
      revisionId: first.revisionId,
      offset: first.nextOffset!,
    });
    const prepared = yield* service.workspacePrepare(workspaceId, first.revisionId);
    return { revisionId: first.revisionId, preparationId: prepared.preparationId };
  });

export const leasesWith = (override: (base: WriterLeaseContract) => Partial<WriterLeaseContract>) =>
  Layer.effect(
    WriterLeaseService,
    WriterLeaseService.use((base) =>
      Effect.succeed(WriterLeaseService.of({ ...base, ...override(base) })),
    ),
  ).pipe(Layer.provide(fakeWriterLeaseLayer()));

type GatedOperation = "freeze" | "prepare" | "discard";

interface EngineHooks {
  afterCreate: Effect.Effect<void>;
  orphanOwnerEnded?: boolean;
  createFailure?: WorkspaceError;
  setupFailure?: WorkspaceError | undefined;
  before: { [Operation in GatedOperation]?: Effect.Effect<void> | undefined };
  failDiscard: boolean;
}

export const pauseAt = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const pause = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
  return { entered, release, pause };
});

export const gateCreate = (f: ReturnType<typeof workspaceFixture>) =>
  pauseAt.pipe(
    Effect.tap(({ pause }) =>
      Effect.sync(() => {
        f.hooks.afterCreate = pause;
      }),
    ),
  );

export function workspaceFixture({
  sourceCwd = "/repo",
  canonicalize = (cwd: string) => cwd,
  writerLeases,
  profiles,
  children = fakeChildLayer(),
  workspaceSetup,
  serviceOptions,
}: {
  readonly sourceCwd?: string;
  readonly canonicalize?: (cwd: string) => string;
  readonly writerLeases?: Layer.Layer<WriterLeaseService>;
  readonly profiles?: ReturnType<typeof profileLayerFor>;
  readonly children?: ReturnType<typeof fakeChildLayer>;
  readonly workspaceSetup?: { readonly command: ReadonlyArray<string> };
  readonly serviceOptions?: SubagentServiceOptions;
} = {}) {
  const hooks: EngineHooks = { afterCreate: Effect.void, before: {}, failDiscard: false };
  const gated = <A, E>(operation: GatedOperation, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => hooks.before[operation] ?? Effect.void).pipe(Effect.andThen(effect));
  const integrations: WorkspaceIntegrationTarget[] = [];
  const entries = new Map<string, WorkspaceRecord>();
  const unavailable: UnavailableWorkspaceArtifact[] = [];
  const requireEntry = (target: WorkspaceTarget) =>
    Effect.gen(function* () {
      const entry = entries.get(target.workspaceId);
      if (!entry || entry.handle.ownerId !== target.ownerId)
        return yield* new WorkspaceError({ operation: "inspect", message: "Unknown owner" });
      return entry;
    });
  let ordinal = 0;
  let revisions = 0;
  let preparations = 0;
  const engineFor = (leases: WriterLeaseContract): WorkspaceServiceContract => {
    const create: WorkspaceServiceContract["create"] = (input) =>
      Effect.suspend(() =>
        hooks.createFailure ? Effect.fail(hooks.createFailure) : Effect.void,
      ).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const workspaceId = `workspace-${++ordinal}`;
            const handle = {
              workspaceId,
              ownerId: input.ownerId,
              sourceCwd: input.sourceCwd,
              sourceRoot: input.sourceCwd,
              cwd: `/private/${workspaceId}/worker`,
              writerCwd: yield* leases
                .canonicalize(`/private/${workspaceId}/worker`)
                .pipe(
                  Effect.mapError(
                    (error) => new WorkspaceError({ operation: "create", message: error.message }),
                  ),
                ),
            };
            entries.set(workspaceId, {
              version: 1,
              handle,
              status: "active",
              baseline: "original-base",
            });
            input.onAcquired?.(handle);
            return handle;
          }),
        ),
        Effect.tap(() => hooks.afterCreate),
      );
    return {
      create,
      setup: () =>
        Effect.suspend(() => (hooks.setupFailure ? Effect.fail(hooks.setupFailure) : Effect.void)),
      setupChanges: () => Effect.succeed([]),
      inspect: requireEntry,
      list: ({ ownerId }) =>
        Effect.sync(() =>
          [...entries.values()].filter((entry) => entry.handle.ownerId === ownerId),
        ),
      listAll: Effect.sync(() => ({ records: [...entries.values()], unavailable })),
      // Like the real engine, only an active workspace may be frozen.
      freeze: (target) =>
        gated("freeze", requireEntry(target)).pipe(
          Effect.flatMap((entry) => {
            if (entry.status !== "active")
              return Effect.fail(
                new WorkspaceError({
                  operation: "freeze",
                  message: "Only active workspaces may be frozen; revise explicitly first.",
                }),
              );
            const revision = {
              revisionId: `revision-${++revisions}`,
              diff: "a".repeat(20_000),
              changedPaths: ["file.ts"],
            };
            entries.set(target.workspaceId, { ...entry, status: "frozen", revision });
            return Effect.succeed(revision);
          }),
        ),
      prepare: (target) =>
        gated("prepare", requireEntry(target)).pipe(
          Effect.map((entry) => {
            const preparationId = `prepared-${++preparations}`;
            const preparation = {
              preparationId,
              revisionId: target.revisionId,
              cwd: `/private/${target.workspaceId}/prepare-${preparationId}`,
              leaseDirectories: [entry.handle.sourceRoot, `${entry.handle.sourceRoot}/packages/b`],
            };
            entries.set(target.workspaceId, { ...entry, status: "prepared", preparation });
            return preparation;
          }),
        ),
      integrate: (target) =>
        requireEntry(target).pipe(
          Effect.map((entry) => {
            integrations.push(target);
            const integrated = { ...entry, status: "integrated" as const };
            entries.set(target.workspaceId, integrated);
            return {
              record: integrated,
              workerRoot: entry.handle.cwd,
              uncapturedPaths: [],
              treeRemovalFailed: false,
              remainingBackupPaths: [],
            };
          }),
        ),
      revise: (target) =>
        requireEntry(target).pipe(
          Effect.map((entry) => {
            const { revision: _revision, preparation: _preparation, ...rest } = entry;
            entries.set(target.workspaceId, { ...rest, status: "active" });
            return entry.handle;
          }),
        ),
      fork: (target) =>
        requireEntry(target).pipe(
          Effect.flatMap((entry) =>
            create({
              sourceCwd: entry.handle.sourceCwd,
              ownerId: entry.handle.ownerId,
              onAcquired: target.onAcquired,
            }),
          ),
        ),
      discardOrphan: ({ workspaceId }) =>
        Effect.suspend(() => {
          const entry = entries.get(workspaceId);
          if (!entry || !hooks.orphanOwnerEnded)
            return Effect.fail(
              new WorkspaceError({
                operation: "authorization",
                message: "The session that created this workspace is still running.",
              }),
            );
          entries.set(workspaceId, { ...entry, status: "discarded" });
          return Effect.void;
        }),
      discard: (target) =>
        gated("discard", requireEntry(target)).pipe(
          Effect.flatMap((entry) =>
            hooks.failDiscard
              ? Effect.fail(
                  new WorkspaceError({ operation: "discard", message: "Fixture failure" }),
                )
              : Effect.sync(() => {
                  entries.set(target.workspaceId, { ...entry, status: "discarded" });
                }),
          ),
        ),
    };
  };
  const acquired: string[] = [];
  const released: string[] = [];
  const canonicalized: string[] = [];
  const leaseLayer =
    writerLeases ??
    fakeWriterLeaseLayer({
      canonicalize,
      onCanonicalize: (cwd) => canonicalized.push(cwd),
      onAcquire: (lease) => acquired.push(lease.canonicalCwd),
      onRelease: (lease) => released.push(lease.canonicalCwd),
    });
  const layer = serviceLayer(
    {
      ...serviceOptions,
      writerWorkspaceMode: "worktree",
      workspaceOwnerId: "session-1",
      workspaceSourceCwd: sourceCwd,
      workspaceSetup,
    },
    profiles,
    leaseLayer,
  ).pipe(
    Layer.provide(children.layer),
    Layer.provide(
      Layer.effect(WorkspaceService, Effect.map(WriterLeaseService, engineFor)).pipe(
        Layer.provide(leaseLayer),
      ),
    ),
  );
  const statuses = () => [...entries.values()].map((entry) => entry.status);
  return {
    entries,
    unavailable,
    children,
    layer,
    acquired,
    released,
    canonicalized,
    hooks,
    integrations,
    statuses,
  };
}
