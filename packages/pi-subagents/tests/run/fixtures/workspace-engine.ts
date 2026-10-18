import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  type WriterLeaseContract,
  WriterLeaseService,
} from "../../../src/boundary/writer-lease.ts";
import { isWithin } from "../../../src/run/workspace-binding.ts";
import {
  WorkspaceError,
  workspaceCheckoutRoot,
  type UnavailableWorkspaceArtifact,
  type WorkspaceExport,
  type WorkspaceExportRequest,
  type WorkspaceIntegrationTarget,
  type WorkspaceRebase,
  type WorkspaceRecord,
  type WorkspaceTarget,
  type WorkspaceVerifyTarget,
  type WorkspaceWorkerChanges,
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

type GatedOperation =
  | "create"
  | "freeze"
  | "prepare"
  | "discard"
  | "setup"
  | "verify"
  | "inspectWorkerChanges";

interface EngineHooks {
  afterCreate: Effect.Effect<void>;
  orphanOwnerEnded?: boolean;
  createFailure?: WorkspaceError;
  setupFailure?: WorkspaceError | undefined;
  verifyFailure?: WorkspaceError | undefined;
  verifyOutputTail: string;
  workerChanges: WorkspaceWorkerChanges | WorkspaceError;
  before: { [Operation in GatedOperation]?: Effect.Effect<void> | undefined };
  failDiscard: boolean;
  /** Integration stops mid-publication, leaving the record integrating. */
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

const refuse = (operation: string, message: string) =>
  Effect.fail(new WorkspaceError({ operation, message }));

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
  const hooks: EngineHooks = {
    afterCreate: Effect.void,
    verifyOutputTail: "verified",
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
  const exports: Array<{ readonly workspaceId: string; readonly request: WorkspaceExportRequest }> =
    [];
  /** Each rebase's workspace, in order. */
  const rebases: string[] = [];
  const verifications: WorkspaceVerifyTarget[] = [];
  /** Each setup's tree: a preparation id, or "worker" for the worker tree. */
  const setups: string[] = [];
  const entries = new Map<string, WorkspaceRecord>();
  const diffs = new Map<string, string>();
  const unavailable: UnavailableWorkspaceArtifact[] = [];
  // Like the real engine, a quarantined record refuses every operation on it.
  const requireEntry = (target: WorkspaceTarget) =>
    Effect.gen(function* () {
      const entry = entries.get(target.workspaceId);
      if (!entry || entry.handle.ownerId !== target.ownerId)
        return yield* new WorkspaceError({ operation: "inspect", message: "Unknown owner" });
      if (entry.setupCleanupPending !== undefined)
        return yield* new WorkspaceError({
          operation: "setup",
          message: "Workspace setup or verification cleanup is unconfirmed.",
          cleanupUnconfirmed: true,
        });
      return entry;
    });
  // Like the real engine, a command's durable marker stays only when its cleanup is unconfirmed;
  // an interrupted command is modeled as confirmed stopped.
  const quarantined = <A>(workspaceId: string, effect: Effect.Effect<A, WorkspaceError>) =>
    effect.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          const entry = entries.get(workspaceId);
          if (error.cleanupUnconfirmed && entry)
            entries.set(workspaceId, { ...entry, setupCleanupPending: entry.handle.cwd });
        }),
      ),
    );
  const requirePreparation = (target: WorkspaceVerifyTarget) =>
    requireEntry(target).pipe(
      Effect.filterOrFail(
        (entry) =>
          entry.status === "prepared" && entry.preparation?.preparationId === target.preparationId,
        () =>
          new WorkspaceError({
            operation: "verify",
            message: "The verification tree is stale or unavailable.",
          }),
      ),
    );
  // Like the real engine, children are the unfinished workspaces created from a worker tree.
  const childrenOf = (workspaceId: string) =>
    [...entries.values()].flatMap((entry) =>
      entry.handle.sourceWorkspaceId === workspaceId && !finished(entry)
        ? [entry.handle.workspaceId]
        : [],
    );
  // A nested workspace prepares and integrates only into a still-open source worker tree.
  const requireOpenSource = (entry: WorkspaceRecord, operation: string) => {
    const sourceId = entry.handle.sourceWorkspaceId;
    const source = sourceId === undefined ? undefined : entries.get(sourceId);
    return sourceId === undefined ||
      (source && ["active", "frozen", "prepared"].includes(source.status))
      ? Effect.succeed(entry)
      : refuse(operation, "The source workspace's worker tree is no longer open.");
  };
  // Like the real engine, a private source must be the named source workspace's active worker tree.
  const nestedSource = (input: Parameters<WorkspaceServiceContract["create"]>[0]) =>
    Effect.gen(function* () {
      const named = input.sourceWorkspace;
      if (!named) {
        if (input.sourceCwd.startsWith("/private/"))
          return yield* refuse(
            "create",
            "The session directory is inside private workspace storage.",
          );
        return { sourceRoot: input.sourceCwd };
      }
      const parent = entries.get(named.workspaceId);
      if (
        !parent ||
        parent.handle.ownerId !== named.ownerId ||
        parent.status !== "active" ||
        !isWithin(input.sourceCwd, parent.handle.cwd)
      )
        return yield* refuse(
          "create",
          "The session directory isn't the source workspace's worker tree.",
        );
      return {
        sourceRoot: parent.handle.cwd,
        sourceWorkspaceId: parent.handle.workspaceId,
        checkoutRoot: workspaceCheckoutRoot(parent.handle),
      };
    });
  // Like the real engine, export writes a frozen revision without changing the record.
  const exported = (
    entry: WorkspaceRecord,
    requested: WorkspaceExportRequest,
    revisionId: string | undefined,
  ): Effect.Effect<WorkspaceExport, WorkspaceError> => {
    const { revision } = entry;
    if (
      !revision ||
      (entry.status !== "frozen" && entry.status !== "prepared") ||
      (revisionId !== undefined && revision.revisionId !== revisionId)
    )
      return refuse("revision", "Reviewed revision is stale or unknown.");
    exports.push({ workspaceId: entry.handle.workspaceId, request: requested });
    const common = {
      revisionId: revision.revisionId,
      changedPaths: revision.changedPaths,
      uncapturedPaths: [],
    };
    return Effect.succeed(
      requested.format === "patch"
        ? {
            ...common,
            format: "patch",
            path: `/repo/.git/pi-subagents/${entry.handle.workspaceId}-${revision.revisionId}.patch`,
          }
        : {
            ...common,
            format: "branch",
            branch: requested.branch,
            commit: "commit-1",
            base: "head-1",
            identity: "user",
          },
    );
  };
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
        Effect.andThen(nestedSource(input)),
        Effect.flatMap((source) =>
          Effect.gen(function* () {
            const workspaceId = `workspace-${++ordinal}`;
            const handle = {
              workspaceId,
              ownerId: input.ownerId,
              sourceCwd: input.sourceCwd,
              ...source,
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
      setup: (input) =>
        quarantined(
          input.workspaceId,
          Effect.sync(() => setups.push(input.preparationId ?? "worker")).pipe(
            Effect.andThen(
              gated(
                "setup",
                Effect.suspend(() =>
                  hooks.setupFailure ? Effect.fail(hooks.setupFailure) : Effect.void,
                ),
              ),
            ),
          ),
        ),
      // Like the real engine, a failed verification keeps the preparation.
      verify: (input) =>
        quarantined(
          input.workspaceId,
          requirePreparation(input).pipe(
            Effect.tap(() => Effect.sync(() => verifications.push(input))),
            Effect.andThen(
              gated(
                "verify",
                Effect.suspend(() =>
                  hooks.verifyFailure
                    ? Effect.fail(hooks.verifyFailure)
                    : Effect.succeed({ outputTail: hooks.verifyOutputTail }),
                ),
              ),
            ),
          ),
        ),
      setupChanges: () => Effect.succeed([]),
      inspectWorkerChanges: (target) =>
        gated("inspectWorkerChanges", requireEntry(target)).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              hooks.workerChanges instanceof WorkspaceError
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
      unresolvedChildren: ({ workspaceId }) => Effect.sync(() => childrenOf(workspaceId)),
      commandCleanupPending: ({ workspaceId }) =>
        Effect.sync(() => entries.get(workspaceId)?.setupCleanupPending !== undefined),
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
              changedPaths: [...hooks.changedPaths],
            };
            const diff = hooks.revisionDiff ?? "a".repeat(20_000);
            diffs.set(revision.revisionId, diff);
            entries.set(target.workspaceId, { ...entry, status: "frozen", revision });
            return Effect.succeed({ ...revision, diff });
          }),
        ),
      prepare: (target) =>
        gated("prepare", requireEntry(target)).pipe(
          Effect.flatMap((entry) => requireOpenSource(entry, "prepare")),
          Effect.map((entry) => {
            const preparationId = `prepared-${++preparations}`;
            const preparation = {
              preparationId,
              revisionId: target.revisionId,
              cwd: `/private/${target.workspaceId}/prepare-${preparationId}`,
              leaseDirectories: [entry.handle.sourceRoot, `${entry.handle.sourceRoot}/packages/b`],
              ...(target.paths !== undefined && { paths: target.paths }),
            };
            entries.set(target.workspaceId, { ...entry, status: "prepared", preparation });
            return preparation;
          }),
        ),
      integrate: (target) =>
        requireEntry(target).pipe(
          Effect.flatMap((entry) => requireOpenSource(entry, "integrate")),
          Effect.tap((entry) =>
            hooks.integrateStops
              ? Effect.sync(() =>
                  entries.set(target.workspaceId, { ...entry, status: "integrating" }),
                ).pipe(Effect.andThen(refuse("integrate", "Publication stopped partway.")))
              : Effect.void,
          ),
          Effect.map((entry) => {
            integrations.push(target);
            const partial = entry.preparation?.paths;
            if (partial !== undefined) {
              // Like the real engine, a partial integration keeps the rest as an active proposal.
              const { revision, preparation: _preparation, ...rest } = entry;
              const reopened = { ...rest, status: "active" as const, baseline: "advanced-base" };
              entries.set(target.workspaceId, reopened);
              return {
                record: reopened,
                workerRoot: entry.handle.cwd,
                untouchedDriftPaths: [],
                treeRemovalFailed: false,
                remainingBackupPaths: [],
                remainingPaths: (revision?.changedPaths ?? []).filter(
                  (name) => !partial.includes(name),
                ),
              };
            }
            const integrated = { ...entry, status: "integrated" as const };
            entries.set(target.workspaceId, integrated);
            return {
              record: integrated,
              workerRoot: entry.handle.cwd,
              untouchedDriftPaths: [],
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
      rebase: (target) =>
        requireEntry(target).pipe(
          Effect.flatMap((entry) => {
            if (hooks.rebase instanceof WorkspaceError) return Effect.fail(hooks.rebase);
            rebases.push(target.workspaceId);
            const { revision: _revision, preparation: _preparation, ...rest } = entry;
            entries.set(target.workspaceId, { ...rest, status: "active" });
            return Effect.succeed(hooks.rebase);
          }),
        ),
      exportRevision: (target) =>
        requireEntry(target).pipe(
          Effect.flatMap((entry) => exported(entry, target.export, target.revisionId)),
        ),
      exportOrphan: ({ workspaceId, revisionId, export: requested }) =>
        Effect.suspend(() => {
          const entry = entries.get(workspaceId);
          if (!entry || !hooks.orphanOwnerEnded)
            return Effect.fail(
              new WorkspaceError({
                operation: "authorization",
                message: "The session that created this workspace is still running.",
              }),
            );
          // Like the real engine, an unfrozen orphan's worker is captured without freezing it.
          return entry.status === "active" && revisionId === undefined
            ? exported(
                {
                  ...entry,
                  status: "frozen",
                  revision: { revisionId: "worker-capture", changedPaths: [...hooks.changedPaths] },
                },
                requested,
                undefined,
              )
            : exported(entry, requested, revisionId);
        }),
      discardOrphan: ({ workspaceId }) =>
        Effect.suspend(() => {
          const entry = entries.get(workspaceId);
          if (childrenOf(workspaceId).length > 0)
            return refuse("discard", "Unresolved child workspaces use this worker tree.");
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
            childrenOf(target.workspaceId).length > 0
              ? refuse("discard", "Unresolved child workspaces use this worker tree.")
              : hooks.failDiscard
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
  const options: SubagentServiceOptions = {
    ...serviceOptions,
    writerWorkspaceMode: "worktree",
    workspaceOwnerId: "session-1",
    workspaceSourceCwd: sourceCwd,
    workspaceSetup,
  };
  const engineLayer = Layer.effect(
    WorkspaceService,
    Effect.map(WriterLeaseService, engineFor),
  ).pipe(Layer.provide(leaseLayer));
  const layer = serviceLayer(options, profiles, leaseLayer).pipe(
    Layer.provide(children.layer),
    Layer.provide(engineLayer),
  );
  const statuses = () => [...entries.values()].map((entry) => entry.status);
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
    exports,
    rebases,
    verifications,
    setups,
    statuses,
  };
}
