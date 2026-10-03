// Explicit test entry-point Layer provision owns each scoped service runtime.
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import type {
  SubagentNotificationDelivery,
  SubagentWorkflowNotification,
} from "../../../src/boundary/host-notifier.ts";
import type { StartSubagentRequest, SubagentProjection } from "../../../src/run/model.ts";
import { SubagentService, type SubagentServiceContract } from "../../../src/run/service.ts";
import { WorkflowRunFileError } from "../../../src/boundary/workflow-run-files.ts";
import type { WorkspaceRecord } from "../../../src/workspace/model.ts";
import { WorkspaceService, type WorkspaceServiceContract } from "../../../src/workspace/service.ts";
import { WorkflowAgentCallError, type WorkflowHost } from "../../../src/workflow/agent.ts";
import { WorkflowJournal } from "../../../src/workflow/journal.ts";
import type { WorkflowRunView } from "../../../src/workflow/model.ts";
import { parseWorkflowScript } from "../../../src/workflow/script.ts";
import { WorkflowService, type WorkflowServiceContract } from "../../../src/workflow/service.ts";
import {
  WorkflowSourceError,
  WorkflowStore,
  type WorkflowStoreContract,
} from "../../../src/workflow/store.ts";
import {
  fakeNativeReportBackendLayer,
  nativeReportRequest,
  nativeReportServiceFixture,
  profileLayerFor,
} from "../../run/fixtures/service-harness.ts";

const decodeResult = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

/** A finished run's value, parsed from its JSON result text. */
export const resultValue = (run: WorkflowRunView): Schema.Json => decodeResult(run.result?.text);

/** A complete script with the given body. */
export const script = (body: string, name = "test-workflow"): string =>
  `export const meta = { name: ${JSON.stringify(name)}, description: "A test workflow", phases: [{ title: "Main" }] };\n${body}`;

/** Resolves every agent to a native-report launch; `worker` and `writes` make it a writer. */
export const testHost = (
  record: (request: StartSubagentRequest) => void = () => {},
): WorkflowHost => ({
  checkAgent: (spec) =>
    spec.profile === "unknown"
      ? Effect.fail(new WorkflowAgentCallError({ message: 'Unknown agent() profile "unknown".' }))
      : Effect.void,
  resolveAgent: (spec) =>
    Effect.sync(() => {
      const writer = spec.profile === "worker" || spec.writes !== undefined;
      const request = nativeReportRequest({
        task: spec.task,
        name: spec.name,
        ...(spec.profile === "worker" && { profile: "worker" as const }),
        ...(writer && { writeIntent: "writer" as const }),
        ...(spec.writes !== undefined && { writes: spec.writes }),
      });
      record(request);
      return request;
    }),
});

/** Run files kept in memory, with switches that make writing them fail. */
export interface MemoryRunFiles {
  /** Saved script copies by run id. */
  readonly scripts: Map<string, string>;
  /** Results journal lines by journal path. */
  readonly journals: Map<string, string[]>;
  /** The live runs each creation was told not to prune. */
  readonly live: Array<ReadonlySet<string>>;
  failCreate: boolean;
  failAppend: boolean;
  /** The next append writes its line, then waits on this, still holding the journal lock. */
  holdNextAppend: Effect.Effect<void> | undefined;
  /** Run directories marked recent, in order. */
  readonly touches: string[];
}

export const memoryRunFiles = (): MemoryRunFiles => ({
  scripts: new Map(),
  journals: new Map(),
  live: [],
  failCreate: false,
  failAppend: false,
  holdNextAppend: undefined,
  touches: [],
});

/** The decoded results journal lines a run wrote. */
export const journalLines = (files: MemoryRunFiles, path: string | undefined) =>
  (path === undefined ? [] : (files.journals.get(path) ?? [])).map((line) => decodeLine(line));

const decodeLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

/** Saved workflows from memory; script paths are their names. */
export const memoryStore = (
  scripts: Readonly<Record<string, string>>,
  files: MemoryRunFiles = memoryRunFiles(),
): WorkflowStoreContract => {
  const load = (name: string) => {
    const source = scripts[name];
    return source === undefined
      ? Effect.fail(new WorkflowSourceError({ message: `No saved workflow named "${name}".` }))
      : parseWorkflowScript(source).pipe(
          Effect.mapError((error) => new WorkflowSourceError({ message: error.message })),
          Effect.map((parsed) => ({
            name,
            scope: "user" as const,
            path: `/agent/workflows/${name}.js`,
            script: parsed,
          })),
        );
  };
  return {
    load,
    loadPath: load,
    list: Effect.succeed({ workflows: [], diagnostics: [], truncated: false }),
    createRunFiles: (runId, source, live) =>
      Effect.suspend(() => {
        files.live.push(live);
        if (files.failCreate)
          return Effect.fail(
            new WorkflowRunFileError({ message: "Couldn't save the script: EACCES" }),
          );
        files.scripts.set(runId, source);
        const directory = `/agent/subagents/workflow-runs/${runId}`;
        return Effect.succeed({
          directory,
          script: `${directory}/script.js`,
          journal: `${directory}/journal.jsonl`,
        });
      }),
    appendRunJournal: (paths, line) =>
      Effect.suspend(() => {
        if (files.failAppend)
          return Effect.fail(
            new WorkflowRunFileError({ message: "Couldn't write the results journal: ENOSPC" }),
          );
        files.journals.set(paths.journal, [...(files.journals.get(paths.journal) ?? []), line]);
        const hold = files.holdNextAppend;
        files.holdNextAppend = undefined;
        return hold ?? Effect.void;
      }),
    touchRunFiles: (paths) => Effect.sync(() => void files.touches.push(paths.directory)),
  };
};

/**
 * A workspace engine that creates isolated checkouts and keeps each one's record through review,
 * preparation, integration and discard, with a one-page diff per revision.
 */
const creatingWorkspaceEngine = (): WorkspaceServiceContract => {
  let ordinal = 0;
  const records = new Map<string, WorkspaceRecord>();
  const unused = () => Effect.die(new Error("Unexpected workspace operation."));
  const existing = (workspaceId: string) =>
    Effect.suspend(() => {
      const record = records.get(workspaceId);
      return record ? Effect.succeed(record) : unused();
    });
  const save = (record: WorkspaceRecord) =>
    Effect.sync(() => {
      records.set(record.handle.workspaceId, record);
      return record;
    });
  return {
    create: ({ sourceCwd, ownerId }) =>
      Effect.sync(() => {
        const workspaceId = `workspace-${++ordinal}`;
        const handle = {
          workspaceId,
          ownerId,
          sourceCwd,
          sourceRoot: sourceCwd,
          cwd: `/private/${workspaceId}`,
        };
        records.set(workspaceId, { version: 1, handle, status: "active", baseline: "base" });
        return handle;
      }),
    freeze: ({ workspaceId }) =>
      existing(workspaceId).pipe(
        Effect.flatMap((record) => {
          const revision = record.revision ?? {
            revisionId: `revision-${workspaceId}`,
            diff: "diff --git a/fix.ts b/fix.ts",
            changedPaths: ["fix.ts"],
          };
          return save({ ...record, status: "frozen", revision }).pipe(Effect.as(revision));
        }),
      ),
    prepare: ({ workspaceId, revisionId }) =>
      existing(workspaceId).pipe(
        Effect.flatMap((record) => {
          const preparation = {
            preparationId: `preparation-${workspaceId}`,
            revisionId,
            cwd: `/private/${workspaceId}-prepared`,
            leaseDirectories: [record.handle.sourceRoot],
          };
          return save({ ...record, status: "prepared", preparation }).pipe(Effect.as(preparation));
        }),
      ),
    integrate: ({ workspaceId }) =>
      existing(workspaceId).pipe(
        Effect.flatMap((record) => save({ ...record, status: "integrated" })),
        Effect.map((record) => ({
          record,
          workerRoot: record.handle.cwd,
          uncapturedPaths: [],
          treeRemovalFailed: false,
        })),
      ),
    revise: ({ workspaceId }) =>
      existing(workspaceId).pipe(
        Effect.flatMap(({ revision: _revision, preparation: _preparation, ...record }) =>
          save({ ...record, status: "active" }),
        ),
        Effect.map((record) => record.handle),
      ),
    fork: unused,
    discard: ({ workspaceId }) =>
      existing(workspaceId).pipe(
        Effect.flatMap((record) => save({ ...record, status: "discarded" })),
        Effect.asVoid,
      ),
    recoverDiscard: unused,
    inspect: ({ workspaceId }) => existing(workspaceId),
    list: ({ ownerId }) =>
      Effect.sync(() =>
        [...records.values()].filter((record) => record.handle.ownerId === ownerId),
      ),
    listAll: unused,
  };
};

let nextSession = 1;

/** A journal session no other fixture shares. */
export const workflowSessionKey = (): string => `workflow-test-${process.pid}-${nextSession++}`;

export interface WorkflowFixtureOptions {
  readonly backend?: ReturnType<typeof fakeNativeReportBackendLayer>;
  readonly profiles?: ReturnType<typeof profileLayerFor>;
  readonly concurrency?: number;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly worktrees?: boolean;
  /** Whether the host accepts a workflow notification; accepts by default. */
  readonly accept?: (notification: SubagentWorkflowNotification) => boolean;
  /** Delivers to a real host notifier instead of only recording. */
  readonly notify?: (
    notification: SubagentWorkflowNotification,
  ) => SubagentNotificationDelivery | undefined;
  /** Wraps the subagent service the workflow service sees, for example to count calls. */
  readonly decorate?: (service: SubagentServiceContract) => SubagentServiceContract;
  /** Shares resume journals with another fixture, like a later activation of one session. */
  readonly sessionKey?: string;
  /** Where runs save their script and results journal. */
  readonly runFiles?: MemoryRunFiles;
  /** How often live runs mark their directory recent. */
  readonly runFilesRefresh?: Duration.Input;
}

/** The real subagent service over a native-report backend, plus the workflow service. */
export const workflowFixture = (options: WorkflowFixtureOptions = {}) => {
  const backend = options.backend ?? fakeNativeReportBackendLayer();
  const subagents = nativeReportServiceFixture(backend, {}, options.profiles);
  const subagentLayer = options.worktrees
    ? subagents.layer.pipe(
        Layer.provide(Layer.succeed(WorkspaceService, creatingWorkspaceEngine())),
      )
    : subagents.layer;
  const workflowNotifications: SubagentWorkflowNotification[] = [];
  const delivered: SubagentWorkflowNotification[] = [];
  const runFiles = options.runFiles ?? memoryRunFiles();
  const decorate = options.decorate;
  const workflowSubagents = decorate
    ? Layer.effect(
        SubagentService,
        SubagentService.use((service) => Effect.succeed(decorate(service))),
      ).pipe(Layer.provide(subagentLayer))
    : subagentLayer;
  const layer = WorkflowService.layer({
    concurrency: options.concurrency ?? 4,
    ...(options.runFilesRefresh !== undefined && { runFilesRefresh: options.runFilesRefresh }),
    notify: (notification) => {
      workflowNotifications.push(notification);
      if (options.notify) return options.notify(notification);
      const accepted = options.accept?.(notification) ?? true;
      if (accepted) delivered.push(notification);
      return { actionAccepted: accepted };
    },
  }).pipe(
    Layer.provide(workflowSubagents),
    Layer.provideMerge(
      Layer.mergeAll(
        subagentLayer,
        WorkflowJournal.layer(options.sessionKey ?? workflowSessionKey()),
        Layer.succeed(WorkflowStore, memoryStore(options.scripts ?? {}, runFiles)),
        nodeFilePlatformLayer,
      ),
    ),
  );
  return {
    backend,
    projections: subagents.projections,
    rootNotifications: subagents.notifications,
    workflowNotifications,
    delivered,
    runFiles,
    layer,
  };
};

/** Runs a body against the fixture's services; the layer closes when it returns. */
export const withWorkflows = <A, E>(
  fixture: ReturnType<typeof workflowFixture>,
  body: (
    workflows: WorkflowServiceContract,
    subagents: SubagentServiceContract,
  ) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    return yield* body(yield* WorkflowService, yield* SubagentService);
  }).pipe(Effect.scoped, Effect.provide(fixture.layer));

/** Polls a condition on real time; sandbox scripts run in a worker thread. */
export const eventually = <A>(probe: () => A | undefined, label: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt++) {
      const value = probe();
      if (value !== undefined) return value;
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${label}.`));
  });

/** The first view of a run that satisfies `predicate`. */
export const runWhere = (
  workflows: WorkflowServiceContract,
  id: string,
  predicate: (run: WorkflowRunView) => boolean,
) =>
  workflows.changes.pipe(
    Stream.map((runs) => runs.find((run) => run.id === id)),
    Stream.filter((run): run is WorkflowRunView => run !== undefined && predicate(run)),
    Stream.runHead,
    Effect.flatMap((found) =>
      Option.match(found, {
        onNone: () => Effect.die(new Error(`Workflow ${id} ended its changes.`)),
        onSome: Effect.succeed,
      }),
    ),
    Effect.timeoutOrElse({
      duration: "8 seconds",
      orElse: () => Effect.die(new Error(`Timed out waiting for workflow ${id}.`)),
    }),
  );

export const finished = (workflows: WorkflowServiceContract, id: string) =>
  runWhere(workflows, id, (run) => run.endedAt !== undefined);

const runsOf = (projections: ReadonlyArray<SubagentProjection>, task: string) =>
  projections.at(-1)?.runs.filter((run) => run.task === task) ?? [];

const runningRun = (projections: ReadonlyArray<SubagentProjection>, task: string) =>
  runsOf(projections, task).find((run) => run.state === "running");

/** Waits until the agent with `task` is running, then reports `text` as its result. */
export const reportTask = (
  fixture: ReturnType<typeof workflowFixture>,
  task: string,
  text: string,
) =>
  Effect.gen(function* () {
    const run = yield* eventually(
      () => runningRun(fixture.projections, task),
      `agent "${task}" to run`,
    );
    const control = yield* controlForTask(fixture, task);
    control.report(run.id, 1, `report-${run.id}`, text);
    return run.id;
  });

/** The backend process that received `task`, matched on the exact assigned-task section. */
export const controlForTask = (fixture: ReturnType<typeof workflowFixture>, task: string) =>
  eventually(
    () =>
      fixture.backend.controls.findLast((candidate) =>
        candidate.prompts.some((prompt) => prompt.includes(`Assigned task:\n${task}\n\n`)),
      ),
    `agent "${task}" to receive its prompt`,
  );

/** Waits until the agent with `task` is running and returns its subagent run id. */
export const runningTask = (fixture: ReturnType<typeof workflowFixture>, task: string) =>
  eventually(() => runningRun(fixture.projections, task)?.id, `agent "${task}" to run`);

/** The state of the only subagent run that received `task`. */
export const stateOfTask = (fixture: ReturnType<typeof workflowFixture>, task: string) => {
  const runs = runsOf(fixture.projections, task);
  if (runs.length > 1) throw new Error(`Several agents received "${task}".`);
  return runs[0]?.state;
};

export { profileLayerFor, fakeNativeReportBackendLayer };
