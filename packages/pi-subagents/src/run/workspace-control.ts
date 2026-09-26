import * as Effect from "effect/Effect";
import type { WriterLease } from "../boundary/writer-lease.ts";
import type { WriterWorkspaceMode } from "../config/schema.ts";
import type {
  WorkspaceHandle,
  WorkspaceListing,
  WorkspacePreparation,
  WorkspaceRecord,
  WorkspaceRevision,
} from "../workspace/model.ts";
import type { WorkspaceServiceContract } from "../workspace/service.ts";
import { invalidRequest as invalid, type SubagentError } from "./errors.ts";
import type { RunContext, RunRecord } from "./internal.ts";
import {
  isActiveRunState,
  SUBAGENT_ROOT_RUN_ID,
  type StartSubagentRequest,
  type SubagentRunView,
} from "./model.ts";
import type { WriterPoolEntry } from "./writer-pool.ts";

export interface WorkspaceReview extends WorkspaceRevision {
  readonly workspaceId: string;
  readonly offset: number;
  readonly totalChars: number;
  readonly nextOffset?: number;
}
export interface WorkspaceCoordinatorContract {
  readonly workspaceList: (callerRunId?: string) => Effect.Effect<WorkspaceListing, SubagentError>;
  readonly workspaceReview: (
    workspaceId: string,
    options?: { readonly revisionId?: string; readonly offset?: number; readonly limit?: number },
    callerRunId?: string,
  ) => Effect.Effect<WorkspaceReview, SubagentError>;
  readonly workspacePrepare: (
    workspaceId: string,
    revisionId: string,
    callerRunId?: string,
  ) => Effect.Effect<WorkspacePreparation, SubagentError>;
  readonly workspaceIntegrate: (
    workspaceId: string,
    revisionId: string,
    preparationId: string,
    callerRunId?: string,
  ) => Effect.Effect<void, SubagentError>;
  readonly workspaceDiscard: (
    workspaceId: string,
    callerRunId?: string,
  ) => Effect.Effect<void, SubagentError>;
  readonly workspaceRevise: (
    workspaceId: string,
    message: string,
    callerRunId?: string,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly inspectWriterWorkspace: Effect.Effect<
    {
      readonly mode: WriterWorkspaceMode;
      readonly canSwitch: boolean;
      readonly blockedReason?: string;
    },
    SubagentError
  >;
  readonly setWriterWorkspaceMode: <A, E, R>(
    mode: WriterWorkspaceMode,
    persist: Effect.Effect<A, E, R>,
  ) => Effect.Effect<void, SubagentError | E, R>;
}

interface Binding {
  readonly handle: WorkspaceHandle;
  readonly request: StartSubagentRequest;
  record?: RunRecord;
  preparing: boolean;
  reviewedRevision?: string | undefined;
  reviewedThrough?: number | undefined;
}
const mapWorkspaceError = (error: { readonly message: string }) =>
  invalid("workspace_operation_failed", error.message);

/** Artifacts deliberately outlive terminal-history entries and backend scopes. */
export function makeWorkspaceControl(
  dependencies: Omit<RunContext, "writerPools"> & {
    readonly writerPools: ReadonlyMap<string, WriterPoolEntry>;
    readonly engine: WorkspaceServiceContract | undefined;
    readonly initialMode: WriterWorkspaceMode;
    readonly ownerId: string;
    readonly sourceCwd?: string;
    readonly isClosed: () => boolean;
  },
) {
  const { engine, ownerId, records, writerPools, withLock, isClosed } = dependencies;
  let mode = dependencies.initialMode;
  let reservations = 0;
  const bindings = new Map<string, Binding>();
  const ownerFor = (caller: string) => `${ownerId}/${caller}`;
  const sourceRecords = (listing: WorkspaceListing) =>
    Effect.gen(function* () {
      const entries = listing.records;
      const owned = (record: WorkspaceRecord) => record.handle.ownerId.startsWith(`${ownerId}/`);
      // Resolve aliases only when inspecting foreign artifacts, never during reader startup.
      const source =
        dependencies.sourceCwd !== undefined && entries.some((record) => !owned(record))
          ? (yield* dependencies.writerLeases
              .canonicalize(dependencies.sourceCwd)
              .pipe(Effect.mapError(mapWorkspaceError))).path
          : undefined;
      return {
        // Unknown source identity cannot justify hiding an artifact from the root.
        unavailable: listing.unavailable,
        records: entries.filter(
          (record) =>
            owned(record) ||
            (source !== undefined &&
              (source === record.handle.sourceRoot ||
                source.startsWith(`${record.handle.sourceRoot.replace(/\/$/, "")}/`))),
        ),
      };
    });
  let integrationQuarantined = false;
  const requireEngine = () =>
    engine
      ? Effect.succeed(engine)
      : Effect.fail(
          invalid(
            "workspace_unavailable",
            "Private workspace service is unavailable. Writer launch is denied.",
          ),
        );
  const requireBinding = (workspaceId: string, caller: string) =>
    Effect.gen(function* () {
      const binding = bindings.get(workspaceId);
      if (!binding || binding.handle.ownerId !== ownerFor(caller))
        return yield* invalid(
          "workspace_owner_unavailable",
          "Workspace mutation requires its authenticated direct parent and live coordinator ownership evidence. Persisted artifacts without cleanup evidence require manual recovery.",
        );
      if (
        binding.preparing ||
        (binding.record &&
          (binding.record.process !== undefined ||
            binding.record.cleanupPending ||
            binding.record.cleanupDisposition !== "confirmed" ||
            isActiveRunState(binding.record.view.state)))
      )
        return yield* invalid(
          "workspace_process_unsettled",
          "Stop the workspace writer and confirm complete process cleanup before reviewing or changing its artifact.",
        );
      return binding;
    });
  const all = () =>
    engine
      ? engine.listAll().pipe(Effect.mapError(mapWorkspaceError))
      : Effect.succeed<WorkspaceListing>({ records: [], unavailable: [] });
  const blockedReason = () =>
    Effect.gen(function* () {
      if (
        integrationQuarantined ||
        reservations > 0 ||
        [...records.values()].some(
          (record) =>
            record.view.writeIntent === "writer" &&
            (isActiveRunState(record.view.state) ||
              record.cleanupPending ||
              record.cleanupDisposition === "quarantined" ||
              record.evictionClaim !== undefined),
        ) ||
        writerPools.size > 0
      )
        return "Writers, admission reservations, or quarantined writer ownership remain.";
      // Unknown previous-session artifacts are not evidence of process death. Never silently adopt them.
      const listing = yield* all();
      if (listing.unavailable.length > 0)
        return "Workspace recovery metadata is unavailable. Ownership, source identity, and cleanup are unknown; preserve the artifacts and resolve them manually before changing workspace mode.";
      const pending = (yield* sourceRecords(listing)).records.find(
        (record) => record.status !== "integrated" && record.status !== "discarded",
      );
      if (pending)
        return `Unresolved workspace ${pending.handle.workspaceId} remains at ${pending.handle.cwd}. Inspect subagent_workspace list. If its original coordinator is unavailable, preserve the directory, independently confirm every old writer process is stopped, and recover its diff manually; this session cannot attest cleanup or delete it.`;
      return undefined;
    });
  const inspectWriterWorkspace = withLock(
    Effect.gen(function* () {
      const reason = yield* blockedReason();
      return { mode, canSwitch: reason === undefined, ...(reason && { blockedReason: reason }) };
    }),
  );
  const setWriterWorkspaceMode: WorkspaceCoordinatorContract["setWriterWorkspaceMode"] = (
    next,
    persist,
  ) =>
    withLock(
      Effect.gen(function* () {
        if (isClosed())
          return yield* invalid("workspace_runtime_closed", "The subagent session is closed.");
        const reason = yield* blockedReason();
        if (reason) return yield* invalid("workspace_mode_busy", reason);
        // Admission stays locked through the durable preference commit and mode publication.
        // Cancellation cannot split persisted and current-session mode after the save commits.
        yield* Effect.uninterruptible(
          persist.pipe(
            Effect.andThen(
              Effect.sync(() => {
                mode = next;
              }),
            ),
          ),
        );
      }),
    );
  const bind = (record: RunRecord, request: StartSubagentRequest) => {
    if (!request.workspace) return;
    const binding = bindings.get(request.workspace.workspaceId);
    if (binding) binding.record = record;
  };
  const withLaunch = (
    request: StartSubagentRequest,
    start: (request: StartSubagentRequest) => Effect.Effect<SubagentRunView, SubagentError>,
    reuse?: WorkspaceHandle,
  ): Effect.Effect<SubagentRunView, SubagentError> => {
    if (request.writeIntent !== "writer")
      return start({ ...request, workspace: undefined, writerWorkspaceMode: undefined });
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const selectedMode = yield* withLock(
          Effect.gen(function* () {
            if (isClosed())
              return yield* invalid("workspace_runtime_closed", "The subagent session is closed.");
            if (integrationQuarantined)
              return yield* invalid(
                "workspace_integration_quarantined",
                "Integration ownership is quarantined; writer admission is blocked.",
              );
            const predecessor = request.supersedes
              ? records.get(request.supersedes.runId)
              : undefined;
            const selected = predecessor?.view.writerWorkspaceMode ?? mode;
            if (
              selected === "worktree" &&
              (request.parentRunId ?? SUBAGENT_ROOT_RUN_ID) !== SUBAGENT_ROOT_RUN_ID
            )
              return yield* invalid(
                "workspace_nested_writer_unsupported",
                "Worktree writers must be launched by the root parent. Ask the root to launch this writer; nested read-only work and shared-checkout nesting remain available.",
              );
            reservations += 1;
            return selected;
          }),
        );
        let binding: Binding | undefined;
        return yield* Effect.gen(function* () {
          if (selectedMode === "shared-checkout")
            return yield* restore(
              start({ ...request, workspace: undefined, writerWorkspaceMode: selectedMode }),
            );
          const service = yield* requireEngine();
          const caller = request.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
          const predecessor = request.supersedes
            ? records.get(request.supersedes.runId)
            : undefined;
          let handle = reuse;
          if (!handle && predecessor?.view.workspaceId) {
            const prior = yield* withLock(requireBinding(predecessor.view.workspaceId, caller));
            handle = yield* restore(
              service
                .fork({
                  workspaceId: prior.handle.workspaceId,
                  ownerId: ownerFor(caller),
                  processCleanupConfirmed: true,
                })
                .pipe(Effect.mapError(mapWorkspaceError)),
            );
          }
          if (!handle)
            handle = yield* restore(
              service
                .create({ sourceCwd: request.cwd, ownerId: ownerFor(caller) })
                .pipe(Effect.mapError(mapWorkspaceError)),
            );
          binding = {
            handle,
            request: { ...request, cwd: handle.sourceCwd, workspace: undefined },
            preparing: true,
          };
          const ownedBinding = binding;
          yield* withLock(
            Effect.sync(() => bindings.set(ownedBinding.handle.workspaceId, ownedBinding)),
          );
          return yield* restore(
            start({
              ...request,
              cwd: handle.cwd,
              workspace: handle,
              writerWorkspaceMode: selectedMode,
            }),
          );
        }).pipe(
          Effect.ensuring(
            withLock(
              Effect.sync(() => {
                reservations -= 1;
                if (binding) binding.preparing = false;
              }),
            ),
          ),
        );
      }),
    );
  };
  const workspaceList: WorkspaceCoordinatorContract["workspaceList"] = (
    caller = SUBAGENT_ROOT_RUN_ID,
  ) =>
    Effect.gen(function* () {
      const service = yield* requireEngine();
      return caller === SUBAGENT_ROOT_RUN_ID
        ? yield* service
            .listAll()
            .pipe(Effect.mapError(mapWorkspaceError), Effect.flatMap(sourceRecords))
        : yield* service.list({ ownerId: ownerFor(caller) }).pipe(
            Effect.mapError(mapWorkspaceError),
            Effect.map((records): WorkspaceListing => ({ records, unavailable: [] })),
          );
    });
  const workspaceReview: WorkspaceCoordinatorContract["workspaceReview"] = (
    workspaceId,
    options = {},
    caller = SUBAGENT_ROOT_RUN_ID,
  ) =>
    withLock(
      Effect.gen(function* () {
        const binding = yield* requireBinding(workspaceId, caller);
        const service = yield* requireEngine();
        const offset = options.offset ?? 0;
        const limit = options.limit ?? 16_000;
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 16_000
        )
          return yield* invalid(
            "workspace_diff_bounds",
            "Diff offset must be a nonnegative integer and limit must be 1 through 16000.",
          );
        let revision: WorkspaceRevision;
        if (options.revisionId) {
          const entry = (yield* service
            .list({ ownerId: binding.handle.ownerId })
            .pipe(Effect.mapError(mapWorkspaceError))).find(
            (entry) => entry.handle.workspaceId === workspaceId,
          );
          if (!entry?.revision || entry.revision.revisionId !== options.revisionId)
            return yield* invalid(
              "workspace_revision_stale",
              "The immutable workspace revision no longer matches.",
            );
          revision = entry.revision;
        } else
          revision = yield* service
            .freeze({ workspaceId, ownerId: binding.handle.ownerId, processCleanupConfirmed: true })
            .pipe(Effect.mapError(mapWorkspaceError));
        if (offset > revision.diff.length)
          return yield* invalid("workspace_diff_bounds", "Diff offset exceeds this revision.");
        const nextOffset = Math.min(revision.diff.length, offset + limit);
        if (binding.reviewedRevision !== revision.revisionId) {
          binding.reviewedRevision = revision.revisionId;
          binding.reviewedThrough = 0;
        }
        if (offset <= (binding.reviewedThrough ?? 0))
          binding.reviewedThrough = Math.max(binding.reviewedThrough ?? 0, nextOffset);
        return {
          ...revision,
          workspaceId,
          diff: revision.diff.slice(offset, nextOffset),
          offset,
          totalChars: revision.diff.length,
          ...(nextOffset < revision.diff.length && { nextOffset }),
        };
      }),
    );
  const workspacePrepare: WorkspaceCoordinatorContract["workspacePrepare"] = (
    workspaceId,
    revisionId,
    caller = SUBAGENT_ROOT_RUN_ID,
  ) =>
    withLock(
      Effect.gen(function* () {
        const binding = yield* requireBinding(workspaceId, caller);
        const service = yield* requireEngine();
        const entry = (yield* service
          .list({ ownerId: binding.handle.ownerId })
          .pipe(Effect.mapError(mapWorkspaceError))).find(
          (entry) => entry.handle.workspaceId === workspaceId,
        );
        if (
          binding.reviewedRevision !== revisionId ||
          !entry?.revision ||
          entry.revision.revisionId !== revisionId ||
          binding.reviewedThrough !== entry.revision.diff.length
        )
          return yield* invalid(
            "workspace_review_incomplete",
            "Read every page of this exact immutable revision before preparing integration.",
          );
        return yield* service
          .prepare({ workspaceId, ownerId: binding.handle.ownerId, revisionId })
          .pipe(Effect.mapError(mapWorkspaceError));
      }),
    );
  const workspaceIntegrate: WorkspaceCoordinatorContract["workspaceIntegrate"] = (
    workspaceId,
    revisionId,
    preparationId,
    caller = SUBAGENT_ROOT_RUN_ID,
  ) =>
    withLock(
      Effect.gen(function* () {
        const binding = yield* requireBinding(workspaceId, caller);
        const service = yield* requireEngine();
        if (
          reservations > 0 ||
          [...records.values()].some(
            (record) =>
              record.view.writeIntent === "writer" &&
              record.view.cwd === binding.handle.sourceCwd &&
              (isActiveRunState(record.view.state) || record.cleanupPending),
          )
        )
          return yield* invalid(
            "workspace_target_busy",
            "The integration target still has writer ownership or admission reservations.",
          );
        const leases = dependencies.writerLeases;
        const artifact = yield* service
          .inspect({ workspaceId, ownerId: binding.handle.ownerId })
          .pipe(Effect.mapError(mapWorkspaceError));
        if (
          !artifact.preparation ||
          artifact.preparation.preparationId !== preparationId ||
          artifact.preparation.revisionId !== revisionId
        )
          return yield* invalid(
            "workspace_preparation_stale",
            "The tested integration preparation no longer matches this revision.",
          );
        const roots = yield* Effect.forEach(artifact.preparation.leaseDirectories, (cwd) =>
          leases.canonicalize(cwd).pipe(Effect.mapError(mapWorkspaceError)),
        );
        const sources = [...new Map(roots.map((cwd) => [cwd.digest, cwd])).values()].sort(
          (left, right) => left.digest.localeCompare(right.digest),
        );
        // The engine lists every existing touched-file ancestor, so subdirectory-scoped cooperative writers conflict too.
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const owned: WriterLease[] = [];
            let applying = false;
            yield* Effect.gen(function* () {
              for (const cwd of sources)
                owned.push(
                  // acquire keeps only its pre-ownership checks interruptible. Keep the
                  // returned lease masked until the finalizer can see it.
                  yield* leases
                    .acquire({ cwd, runId: workspaceId })
                    .pipe(Effect.mapError(mapWorkspaceError)),
                );
              yield* restore(Effect.void);
              // Crash evidence must not be reclaimed as an unused reservation after source publication starts.
              for (const lease of owned)
                yield* leases.markSpawnStarted(lease).pipe(Effect.mapError(mapWorkspaceError));
              applying = true;
              yield* service
                .integrate({
                  workspaceId,
                  ownerId: binding.handle.ownerId,
                  revisionId,
                  preparationId,
                  processCleanupConfirmed: true,
                })
                .pipe(Effect.mapError(mapWorkspaceError));
              applying = false;
            }).pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  if (applying) {
                    const state = yield* service
                      .inspect({ workspaceId, ownerId: binding.handle.ownerId })
                      .pipe(Effect.option);
                    if (state._tag === "None" || state.value.status === "integrating") {
                      integrationQuarantined = true;
                      return;
                    }
                  }
                  for (const lease of owned.reverse())
                    yield* leases.release(lease).pipe(
                      Effect.catch(() =>
                        Effect.sync(() => {
                          integrationQuarantined = true;
                        }),
                      ),
                    );
                }),
              ),
            );
            if (integrationQuarantined)
              return yield* invalid(
                "workspace_integration_quarantined",
                "Integration lease release is unconfirmed. Further writer admission is blocked pending manual recovery.",
              );
          }),
        );
      }),
    );
  const workspaceDiscard: WorkspaceCoordinatorContract["workspaceDiscard"] = (
    workspaceId,
    caller = SUBAGENT_ROOT_RUN_ID,
  ) =>
    withLock(
      Effect.gen(function* () {
        const binding = yield* requireBinding(workspaceId, caller);
        const service = yield* requireEngine();
        yield* service
          .discard({ workspaceId, ownerId: binding.handle.ownerId, processCleanupConfirmed: true })
          .pipe(Effect.mapError(mapWorkspaceError));
      }),
    );
  const invalidateForResume = (record: RunRecord): Effect.Effect<void, SubagentError> =>
    Effect.gen(function* () {
      if (!record.view.workspaceId) return;
      const binding = bindings.get(record.view.workspaceId);
      if (!binding || binding.record !== record)
        return yield* invalid(
          "workspace_owner_unavailable",
          "Workspace resume ownership is unavailable or belongs to a revision successor.",
        );
      binding.reviewedRevision = undefined;
      binding.reviewedThrough = undefined;
      // Live paused processes cannot prove cleanup. Keep review unavailable until they stop.
      if (record.process !== undefined)
        return yield* invalid(
          "workspace_resume_cleanup_required",
          "Stop this workspace writer before requesting a revision successor.",
        );
      const service = yield* requireEngine();
      yield* service
        .revise({
          workspaceId: binding.handle.workspaceId,
          ownerId: binding.handle.ownerId,
          processCleanupConfirmed: true,
        })
        .pipe(Effect.mapError(mapWorkspaceError));
    });
  const revise =
    (
      start: (
        request: StartSubagentRequest,
        reuse: WorkspaceHandle,
      ) => Effect.Effect<SubagentRunView, SubagentError>,
    ): WorkspaceCoordinatorContract["workspaceRevise"] =>
    (workspaceId, message, caller = SUBAGENT_ROOT_RUN_ID) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (!message.trim())
            return yield* invalid("message_required", "A revision request is required.");
          const binding = yield* withLock(
            Effect.gen(function* () {
              const current = yield* requireBinding(workspaceId, caller);
              const service = yield* requireEngine();
              yield* service
                .revise({
                  workspaceId,
                  ownerId: current.handle.ownerId,
                  processCleanupConfirmed: true,
                })
                .pipe(Effect.mapError(mapWorkspaceError));
              current.preparing = true;
              return current;
            }),
          );
          return yield* restore(
            start(
              {
                ...binding.request,
                task: `${binding.request.task}\n\nParent revision request:\n${message}`,
                supersedes: undefined,
              },
              binding.handle,
            ),
          ).pipe(
            Effect.ensuring(
              withLock(
                Effect.sync(() => {
                  binding.preparing = false;
                }),
              ),
            ),
          );
        }),
      );
  return {
    bind,
    withLaunch,
    invalidateForResume,
    revise,
    workspaceList,
    workspaceReview,
    workspacePrepare,
    workspaceIntegrate,
    workspaceDiscard,
    inspectWriterWorkspace,
    setWriterWorkspaceMode,
  };
}

export type RunWorkspaceControl = ReturnType<typeof makeWorkspaceControl>;
