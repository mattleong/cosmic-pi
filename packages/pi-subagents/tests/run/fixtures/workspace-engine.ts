import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import {
  type WriterLeaseContract,
  WriterLeaseService,
} from "../../../src/boundary/writer-lease.ts";
import {
  WorkspaceError,
  type UnavailableWorkspaceArtifact,
  type WorkspaceIntegrationTarget,
  type WorkspaceRebase,
  type WorkspaceRecord,
  type WorkspaceTarget,
  type WorkspaceWorkerChanges,
} from "../../../src/workspace/model.ts";
import { WorkspaceService, type WorkspaceServiceContract } from "../../../src/workspace/service.ts";
import type { WorktreeCreateSetup } from "../../../src/config/schema.ts";
import type { StartSubagentRequest } from "../../../src/run/model.ts";
import type { SubagentServiceContract, SubagentServiceOptions } from "../../../src/run/service.ts";
import {
  fakeChildLayer,
  fakeWriterLeaseLayer,
  type profileLayerFor,
  request,
  serviceLayer,
} from "./service-harness.ts";
import * as Str from "effect/String";
import * as Arr from "effect/Array";

export const repoWriter = (overrides: Partial<StartSubagentRequest> = {}) =>
  request({ cwd: "/repo", writeIntent: "writer", ...overrides });

export const stoppedWriter = (
  service: SubagentServiceContract,
  overrides?: Partial<StartSubagentRequest>,
) => service.start(repoWriter(overrides)).pipe(Effect.tap((run) => service.stop(run.id)));

export const reviewAndPrepare = (service: SubagentServiceContract, workspaceId: string) =>
  Effect.gen(function* () {
    const { revisionId } = yield* service.workspaceReview(workspaceId);
    const prepared = yield* service.workspacePrepare(workspaceId, revisionId);
    return { revisionId, preparationId: prepared.preparationId };
  });

export const leasesWith = (override: (base: WriterLeaseContract) => Partial<WriterLeaseContract>) =>
  Layer.effect(
    WriterLeaseService,
    WriterLeaseService.use((base) =>
      Effect.succeed(WriterLeaseService.of({ ...base, ...override(base) })),
    ),
  ).pipe(Layer.provide(fakeWriterLeaseLayer()));

type GatedOperation =
  | "create"
  | "freeze"
  | "prepare"
  | "discard"
  | "createHooks"
  | "inspectWorkerChanges";

interface EngineHooks {
  afterCreate: Effect.Effect<void>;
  /** Every session but this fixture's has ended, so their owner leases are free. */
  orphanOwnerEnded?: boolean;
  /** Probing other sessions' owner leases fails, so a listing that probes them fails. */
  ownerProbeFailure?: WorkspaceError;
  createFailure?: WorkspaceError;
  createHookFailure?: WorkspaceError | undefined;
  workerChanges: WorkspaceWorkerChanges | WorkspaceError;
  before: { [Operation in GatedOperation]?: Effect.Effect<void> | undefined };
  failDiscard: boolean;
  /** Integration stops partway, leaving the record integrating. */
  integrateStops?: boolean;
  revisionDiff?: string;
  /** The changed paths each frozen revision lists. */
  changedPaths: ReadonlyArray<string>;
  /** What a rebase reports, or how it fails; it reopens the record either way it succeeds. */
  rebase: WorkspaceRebase | WorkspaceError;
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

const finished = (entry: WorkspaceRecord) =>
  entry.status === "integrated" || entry.status === "discarded";

const ownerRunning = () =>
  Effect.fail(
    WorkspaceError.make({
      operation: "authorization",
      message: "The session that created this workspace is still running.",
    }),
  );

const isOpen = (entry: WorkspaceRecord) =>
  entry.status === "active" || entry.status === "frozen" || entry.status === "prepared";

const refuse = (operation: string, message: string) =>
  Effect.fail(WorkspaceError.make({ operation, message }));

export function workspaceFixture({
  sourceCwd = "/repo",
  canonicalize = (cwd: string) => cwd,
  writerLeases,
  profiles,
  children = fakeChildLayer(),
  worktreeCreate,
  serviceOptions,
}: {
  readonly sourceCwd?: string;
  readonly canonicalize?: (cwd: string) => string;
  readonly writerLeases?: Layer.Layer<WriterLeaseService>;
  readonly profiles?: ReturnType<typeof profileLayerFor>;
  readonly children?: ReturnType<typeof fakeChildLayer>;
  readonly worktreeCreate?: WorktreeCreateSetup;
  readonly serviceOptions?: SubagentServiceOptions;
} = {}) {
  const hooks: EngineHooks = {
    afterCreate: Effect.void,
    // Like the revisions it freezes, the fixture's worker tree has changed by default.
    workerChanges: {
      changedPaths: ["file.ts"],
      uncapturedPaths: [],
      diffStat: [
        { path: "file.ts", change: "modified", binary: false, addedLines: 1, deletedLines: 1 },
      ],
    },
    before: {},
    failDiscard: false,
    changedPaths: ["file.ts"],
    rebase: { reappliedPaths: ["file.ts"], conflictedPaths: [] },
  };
  const gated = <A, E>(operation: GatedOperation, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => hooks.before[operation] ?? Effect.void).pipe(Effect.andThen(effect));
  const integrations: WorkspaceIntegrationTarget[] = [];
  /** Each mid-integration workspace whose integration discard rolled back. */
  const rollbacks: string[] = [];
  /** Each rebase's workspace, in order. */
  const rebases: string[] = [];
  /** Each WorktreeCreate run: its tree (a preparation id, or "worker") and the run it named. */
  const hookRuns: Array<{ readonly tree: string; readonly runId?: string | undefined }> = [];
  const entries = new Map<string, WorkspaceRecord>();
  const diffs = new Map<string, string>();
  const unavailable: UnavailableWorkspaceArtifact[] = [];
  const requireEntry = (target: WorkspaceTarget) =>
    Effect.gen(function* () {
      const entry = entries.get(target.workspaceId);
      if (!entry || entry.handle.ownerId !== target.ownerId)
        return yield* WorkspaceError.make({ operation: "inspect", message: "Unknown owner" });
      return entry;
    });
  // Like the real engine, a source inside private workspace storage is refused.
  const checkoutSource = (input: Parameters<WorkspaceServiceContract["create"]>[0]) =>
    Fn.pipe(input.sourceCwd, Str.startsWith("/private/"))
      ? refuse("create", "The session directory is inside private workspace storage.")
      : Effect.succeed({ sourceRoot: input.sourceCwd });
  // Like the real engine, a record another session created whose owner lease is free.
  const orphaned = (entry: WorkspaceRecord) =>
    hooks.orphanOwnerEnded === true &&
    !finished(entry) &&
    !Fn.pipe(entry.handle.ownerId, Str.startsWith("session-1/"));
  const sweepable = (entry: WorkspaceRecord, minimumAgeMillis: number, now: number) =>
    orphaned(entry) && isOpen(entry) && now - entry.lastChangedAt >= minimumAgeMillis;
  let ordinal = 0;
  let revisions = 0;
  let preparations = 0;
  const engineFor = (leases: WriterLeaseContract): WorkspaceServiceContract => {
    const create: WorkspaceServiceContract["create"] = (input) =>
      gated(
        "create",
        Effect.suspend(() =>
          hooks.createFailure ? Effect.fail(hooks.createFailure) : Effect.void,
        ),
      ).pipe(
        Effect.andThen(checkoutSource(input)),
        Effect.flatMap((source) =>
          Effect.gen(function* () {
            const workspaceId = `workspace-${++ordinal}`;
            const handle = {
              workspaceId,
              ownerId: input.ownerId,
              sourceCwd: input.sourceCwd,
              ...source,
              artifactRoot: `/private/${workspaceId}`,
              cwd: `/private/${workspaceId}/worker`,
              writerCwd: yield* leases
                .canonicalize(`/private/${workspaceId}/worker`)
                .pipe(
                  Effect.mapError((error) =>
                    WorkspaceError.make({ operation: "create", message: error.message }),
                  ),
                ),
            };
            entries.set(workspaceId, {
              version: 2,
              repository: "/repo/.git",
              handle,
              status: "active",
              baseline: "original-base",
              ownerLease: "fixture-owner",
              lastChangedAt: yield* Clock.currentTimeMillis,
              ...(input.launch && { launch: input.launch }),
            });
            input.onAcquired?.(handle);
            return handle;
          }),
        ),
        Effect.tap(() => hooks.afterCreate),
      );
    return {
      create,
      runCreateHooks: (input) =>
        Effect.sync(() =>
          hookRuns.push({ tree: input.preparationId ?? "worker", runId: input.runId }),
        ).pipe(
          Effect.andThen(
            gated(
              "createHooks",
              Effect.suspend(() =>
                hooks.createHookFailure ? Effect.fail(hooks.createHookFailure) : Effect.void,
              ),
            ),
          ),
        ),
      hookChanges: () => Effect.succeed([]),
      inspectWorkerChanges: (target) =>
        gated("inspectWorkerChanges", requireEntry(target)).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              Predicate.isTagged(hooks.workerChanges, "WorkspaceError")
                ? Effect.fail(hooks.workerChanges)
                : Effect.succeed(hooks.workerChanges),
            ),
          ),
        ),
      inspect: requireEntry,
      revision: (target) =>
        requireEntry(target).pipe(
          Effect.map(({ revision }) => {
            const diff = revision && diffs.get(revision.revisionId);
            return revision && diff !== undefined ? { ...revision, diff } : undefined;
          }),
        ),
      list: ({ ownerId }) =>
        Effect.sync(() =>
          Arr.filter([...entries.values()], (entry) => entry.handle.ownerId === ownerId),
        ),
      listRecords: Effect.sync(() => ({ records: [...entries.values()], unavailable })),
      listAll: Effect.suspend(() =>
        hooks.ownerProbeFailure
          ? Effect.fail(hooks.ownerProbeFailure)
          : Effect.succeed({
              records: [...entries.values()],
              unavailable,
              endedOwners: Arr.flatMap([...entries.values()], (entry) =>
                orphaned(entry) ? [entry.handle.workspaceId] : [],
              ),
            }),
      ),
      // Like the real engine, only an active workspace may be frozen.
      freeze: (target) =>
        gated("freeze", requireEntry(target)).pipe(
          Effect.flatMap((entry) => {
            if (entry.status !== "active")
              return Effect.fail(
                WorkspaceError.make({
                  operation: "freeze",
                  message: "Only active workspaces may be frozen; revise explicitly first.",
                }),
              );
            const revision = {
              revisionId: `revision-${++revisions}`,
              changedPaths: [...hooks.changedPaths],
            };
            const diff = hooks.revisionDiff ?? Fn.pipe("a", Str.repeat(20_000));
            diffs.set(revision.revisionId, diff);
            entries.set(target.workspaceId, { ...entry, status: "frozen", revision });
            return Effect.succeed({ ...revision, diff });
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
            };
            entries.set(target.workspaceId, { ...entry, status: "prepared", preparation });
            return preparation;
          }),
        ),
      integrate: (target) =>
        requireEntry(target).pipe(
          Effect.tap((entry) =>
            hooks.integrateStops
              ? Effect.sync(() =>
                  entries.set(target.workspaceId, { ...entry, status: "integrating" }),
                ).pipe(Effect.andThen(refuse("integrate", "Integration stopped partway.")))
              : Effect.void,
          ),
          Effect.map((entry) => {
            integrations.push(target);
            const integrated = { ...entry, status: "integrated" as const };
            entries.set(target.workspaceId, integrated);
            return {
              record: integrated,
              workerRoot: entry.handle.cwd,
              untouchedDriftPaths: [],
              treeRemovalFailed: false,
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
      rebase: (target) =>
        requireEntry(target).pipe(
          Effect.flatMap((entry) => {
            if (Predicate.isTagged(hooks.rebase, "WorkspaceError"))
              return Effect.fail(hooks.rebase);
            rebases.push(target.workspaceId);
            const { revision: _revision, preparation: _preparation, ...rest } = entry;
            entries.set(target.workspaceId, { ...rest, status: "active" });
            return Effect.succeed(hooks.rebase);
          }),
        ),
      discardOrphan: ({ workspaceId }) =>
        Effect.suspend(() => {
          const entry = entries.get(workspaceId);
          if (!entry || !hooks.orphanOwnerEnded) return ownerRunning();
          if (entry.status === "integrating") rollbacks.push(workspaceId);
          entries.set(workspaceId, { ...entry, status: "discarded" });
          return Effect.void;
        }),
      // Like the real engine, only an open orphan is adopted.
      adopt: ({ workspaceId, ownerId }) =>
        Effect.suspend(() => {
          const entry = entries.get(workspaceId);
          if (!entry || !hooks.orphanOwnerEnded) return ownerRunning();
          if (!isOpen(entry)) return refuse("adopt", "The orphan can only be discarded.");
          const handle = { ...entry.handle, ownerId };
          entries.set(workspaceId, { ...entry, handle });
          return Effect.succeed(handle);
        }),
      sweepCandidates: ({ minimumAgeMillis }) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) =>
            Arr.filter([...entries.values()], (entry) => sweepable(entry, minimumAgeMillis, now)),
          ),
        ),
      sweepOrphan: ({ workspaceId, minimumAgeMillis }) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => {
            const entry = entries.get(workspaceId);
            if (!entry || !sweepable(entry, minimumAgeMillis, now)) return undefined;
            entries.set(workspaceId, {
              ...entry,
              status: "discarded",
              disposition: "orphan-swept",
              revision: entry.revision ?? { revisionId: `swept-${workspaceId}`, changedPaths: [] },
            });
            return {
              workspaceId,
              sourceRoot: entry.handle.sourceRoot,
              changedPathCount: entry.revision?.changedPaths.length ?? 0,
              patchPath: `/private/${workspaceId}/revision.diff`,
            };
          }),
        ),
      discard: (target) =>
        gated("discard", requireEntry(target)).pipe(
          Effect.flatMap((entry) =>
            hooks.failDiscard
              ? Effect.fail(
                  WorkspaceError.make({ operation: "discard", message: "Fixture failure" }),
                )
              : Effect.sync(() => {
                  if (entry.status === "integrating") rollbacks.push(target.workspaceId);
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
  const options: SubagentServiceOptions = {
    ...serviceOptions,
    writerWorkspaceMode: "worktree",
    workspaceOwnerId: "session-1",
    workspaceSourceCwd: sourceCwd,
    ...(worktreeCreate && { worktreeCreate }),
  };
  const engineLayer = Layer.effect(
    WorkspaceService,
    Effect.map(WriterLeaseService, engineFor),
  ).pipe(Layer.provide(leaseLayer));
  const layer = serviceLayer(options, profiles, leaseLayer).pipe(
    Layer.provide(children.layer),
    Layer.provide(engineLayer),
  );
  const statuses = () => Arr.map([...entries.values()], (entry) => entry.status);
  return {
    entries,
    unavailable,
    children,
    layer,
    /** For a service over other backends: its options, writer leases, and this engine. */
    options,
    leaseLayer,
    engineLayer,
    acquired,
    released,
    canonicalized,
    hooks,
    integrations,
    rollbacks,
    rebases,
    hookRuns,
    statuses,
  };
}
