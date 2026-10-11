import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import type {
  SubagentNotificationDelivery,
  SubagentWorkflowNotification,
} from "../../../src/boundary/host-notifier.ts";
import { subagentErrorCode, type SubagentError } from "../../../src/run/errors.ts";
import type { StartSubagentRequest, SubagentProjection } from "../../../src/run/model.ts";
import { SubagentService, type SubagentServiceContract } from "../../../src/run/service.ts";
import { WorkflowRunFileError } from "../../../src/boundary/workflow-run-files.ts";
import {
  WorkspaceError,
  type WorkspaceRecord,
  type WorkspaceSettledTarget,
} from "../../../src/workspace/model.ts";
import { WorkspaceService, type WorkspaceServiceContract } from "../../../src/workspace/service.ts";
import type {
  WorkflowAgentAccess,
  WorkflowAgentSpec,
  WorkflowHost,
} from "../../../src/workflow/agent.ts";
import { WorkflowAgentCallError } from "../../../src/workflow/errors.ts";
import { WorkflowJournal, type WorkflowJournalContract } from "../../../src/workflow/journal.ts";
import type { WorkflowRunView } from "../../../src/workflow/model.ts";
import type { WorkflowActivitySink } from "../../../src/workflow/runs.ts";
import { parseWorkflowScript } from "../../../src/workflow/script.ts";
import type { WorkflowRunObserver } from "../../../src/workflow/run-observer.ts";
import {
  WorkflowService,
  type WorkflowServiceContract,
  type WorkflowStartRequest,
} from "../../../src/workflow/service.ts";
import type { WorkflowSourceRequest } from "../../../src/workflow/source.ts";
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

export const resultValue = (run: WorkflowRunView): Schema.Json => decodeResult(run.result?.text);

export const script = (body: string, name = "test-workflow", phases = '[{ title: "Main" }]') =>
  `export const meta = { name: ${JSON.stringify(name)}, description: "A test workflow", phases: ${phases} };\n${body}`;

export const inline = (body: string, name?: string, phases?: string) => ({
  kind: "inline" as const,
  script: script(body, name, phases),
});

export const startScript = (
  workflows: WorkflowServiceContract,
  source: string | WorkflowSourceRequest,
  request: Partial<Omit<WorkflowStartRequest, "source">> = {},
  host: WorkflowHost = testHost(),
) =>
  workflows.start(
    { source: Predicate.isString(source) ? inline(source) : source, args: null, ...request },
    host,
  );

export const worktreeWriter = (task: string): string =>
  `agent(${JSON.stringify(task)}, { profile: "worker", isolation: "worktree" })`;

export const mainChildren = (
  subagents: SubagentServiceContract,
  names: ReadonlyArray<string>,
  nestingPolicy?: StartSubagentRequest["nestingPolicy"],
) =>
  Effect.forEach(names, (name) =>
    subagents.start(
      nativeReportRequest({ name, task: name, ...(nestingPolicy && { nestingPolicy }) }),
    ),
  );

const writes = (call: Pick<WorkflowAgentSpec, "profile" | "writes">): boolean =>
  call.profile === "worker" || call.writes !== undefined;

export const testHost = (
  record: (request: StartSubagentRequest) => void = () => {},
): WorkflowHost => ({
  checkAgent: (options) => {
    if (options.profile === "unknown")
      return Effect.fail(
        new WorkflowAgentCallError({ message: 'Unknown agent() profile "unknown".' }),
      );
    const access: WorkflowAgentAccess = writes(options) ? "writer" : "read-only";
    return Effect.succeed(access);
  },
  resolveAgent: (spec) =>
    Effect.sync(() => {
      const writer = writes(spec);
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

export interface MemoryRunFiles {
  readonly scripts: Map<string, string>;
  readonly journals: Map<string, string[]>;
  readonly records: Map<string, string>;
  readonly results: Map<string, string>;
  readonly writtenAt: Map<string, number>;
  readonly live: Array<ReadonlySet<string>>;
  failCreate: boolean;
  failAppend: boolean;
  failRecord: boolean;
  failResult: boolean;
  holdNextAppend: Effect.Effect<void> | undefined;
  readonly touches: string[];
}

export const memoryRunFiles = (): MemoryRunFiles => ({
  scripts: new Map(),
  journals: new Map(),
  records: new Map(),
  results: new Map(),
  writtenAt: new Map(),
  live: [],
  failCreate: false,
  failAppend: false,
  failRecord: false,
  failResult: false,
  holdNextAppend: undefined,
  touches: [],
});

export const journalLines = (files: MemoryRunFiles, path: string | undefined) =>
  (path === undefined ? [] : (files.journals.get(path) ?? [])).map((line) => decodeLine(line));

const decodeLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

export const runRecord = (files: MemoryRunFiles, runId: string) => {
  const text = files.records.get(runId);
  return text === undefined ? undefined : decodeLine(text);
};

export const patchRunRecord = (
  files: MemoryRunFiles,
  runId: string,
  patch: Readonly<Record<string, Schema.Json>>,
) => {
  const record = runRecord(files, runId);
  if (!record) throw new Error(`No record for ${runId}.`);
  files.records.set(runId, JSON.stringify({ ...record, ...patch }));
};

const RUN_ID = /^wf-[a-z0-9]+-[1-9][0-9]*$/u;

export const memoryRunPaths = (runId: string) => {
  const directory = `/agent/subagents/workflow-runs/${runId}`;
  return {
    directory,
    script: `${directory}/script.js`,
    journal: `${directory}/journal.jsonl`,
    record: `${directory}/run.json`,
  };
};

export const memoryLocations = {
  project: "/project/.pi/workflows",
  projectTrusted: false,
  user: "/agent/workflows",
};

const fileName = (path: string): string => path.split("/").at(-1) ?? path;

const readMemoryScript = (path: string, source: string | undefined) =>
  source === undefined
    ? Effect.fail(
        new WorkflowSourceError({
          message: `Couldn't read the workflow file ${path}.`,
          problem: "unreadable",
          subject: fileName(path),
        }),
      )
    : parseWorkflowScript(source).pipe(
        Effect.mapError(
          (script) =>
            new WorkflowSourceError({
              message: `${path}: ${script.message}`,
              problem: "script",
              subject: fileName(path),
              script,
            }),
        ),
      );

export const memoryStore = (
  scripts: Readonly<Record<string, string>>,
  files: MemoryRunFiles = memoryRunFiles(),
): WorkflowStoreContract => {
  const runIdOf = (paths: { readonly directory: string }) =>
    paths.directory.split("/").at(-1) ?? "";
  const written = (runId: string) =>
    Clock.currentTimeMillis.pipe(Effect.map((now) => void files.writtenAt.set(runId, now)));
  const recordFile = (runId: string, text: string) => ({
    runId,
    files: memoryRunPaths(runId),
    text,
    writtenAt: files.writtenAt.get(runId),
  });
  const load = (name: string) => {
    const path = `/agent/workflows/${name}.js`;
    const source = scripts[name];
    return source === undefined
      ? Effect.fail(
          new WorkflowSourceError({
            message: `No saved workflow named "${name}". Save it as ${path}.`,
            problem: "not-found",
            subject: name,
          }),
        )
      : readMemoryScript(path, source).pipe(
          Effect.map((parsed) => ({ name, scope: "user" as const, path, script: parsed })),
        );
  };
  const loadPath = (path: string) =>
    readMemoryScript(path, scripts[path]).pipe(
      Effect.map((parsed) => ({ name: parsed.meta.name, path, script: parsed })),
    );
  return {
    load,
    loadPath,
    list: Effect.succeed({
      workflows: [],
      diagnostics: [],
      truncated: false,
      locations: memoryLocations,
    }),
    locations: Effect.succeed(memoryLocations),
    createRunFiles: (runId, source, live) =>
      Effect.suspend(() => {
        files.live.push(live);
        if (files.failCreate)
          return Effect.fail(
            new WorkflowRunFileError({ message: "Couldn't save the script: EACCES" }),
          );
        files.scripts.set(runId, source);
        return written(runId).pipe(Effect.as(memoryRunPaths(runId)));
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
        return written(runIdOf(paths)).pipe(Effect.andThen(hold ?? Effect.void));
      }),
    touchRunFiles: (paths) =>
      Effect.sync(() => void files.touches.push(paths.directory)).pipe(
        Effect.andThen(written(runIdOf(paths))),
      ),
    writeRunRecord: (paths, text) =>
      Effect.suspend(() => {
        if (files.failRecord)
          return Effect.fail(
            new WorkflowRunFileError({ message: "Couldn't save the run record: EACCES" }),
          );
        const runId = runIdOf(paths);
        files.records.set(runId, text);
        return written(runId);
      }),
    readRunRecord: (runId) =>
      Effect.sync(() => {
        const text = files.records.get(runId);
        return RUN_ID.test(runId) && text !== undefined ? recordFile(runId, text) : undefined;
      }),
    hasRunFiles: (runId) =>
      Effect.sync(
        () => RUN_ID.test(runId) && (files.scripts.has(runId) || files.records.has(runId)),
      ),
    listRunRecords: (limit, keep) =>
      Effect.sync(() =>
        [...files.records]
          .toReversed()
          .map(([runId, text]) => recordFile(runId, text))
          .filter(keep)
          .slice(0, limit),
      ),
    writeRunResult: (paths, ordinal, text) =>
      Effect.suspend(() => {
        if (files.failResult)
          return Effect.fail(
            new WorkflowRunFileError({ message: "Couldn't save a full result: ENOSPC" }),
          );
        const name = `results/${ordinal}.json`;
        files.results.set(`${paths.directory}/${name}`, text);
        return Effect.succeed(name);
      }),
    readRunResult: (paths, name, maximumChars) =>
      Effect.sync(() => {
        const text = files.results.get(`${paths.directory}/${name}`);
        return text !== undefined && text.length <= maximumChars ? text : undefined;
      }),
    readRunJournal: (paths, maximumChars) =>
      Effect.sync(() => {
        let used = 0;
        const lines: string[] = [];
        for (const line of files.journals.get(paths.journal) ?? []) {
          used += line.length + 1;
          if (used > maximumChars) break;
          lines.push(line);
        }
        return lines;
      }),
  };
};

type FakeWorkerContents = "changed" | "unchanged" | "unreadable" | "undeletable";

interface FakeGate {
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

export const fakeGate: Effect.Effect<FakeGate> = Effect.all({
  entered: Deferred.make<void>(),
  release: Deferred.make<void>(),
});

const passGate = (gate: FakeGate | undefined): Effect.Effect<void> =>
  gate
    ? Deferred.succeed(gate.entered, undefined).pipe(Effect.andThen(Deferred.await(gate.release)))
    : Effect.void;

const creatingWorkspaceEngine = (
  workers: ReadonlyMap<string, FakeWorkerContents>,
  createGates: ReadonlyMap<string, FakeGate>,
  checkGates: ReadonlyMap<string, FakeGate>,
): WorkspaceServiceContract => {
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
      Effect.suspend(() => {
        const workspaceId = `workspace-${++ordinal}`;
        return passGate(createGates.get(workspaceId)).pipe(
          Effect.map(() => {
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
        );
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
    discardUnchanged: <E>(
      { workspaceId }: WorkspaceSettledTarget,
      confirm: (discard: Effect.Effect<void, WorkspaceError>) => Effect.Effect<boolean, E>,
    ) =>
      Effect.suspend(() => passGate(checkGates.get(workspaceId))).pipe(
        Effect.andThen(existing(workspaceId)),
        Effect.flatMap((record): Effect.Effect<boolean, WorkspaceError | E> => {
          const contents = workers.get(workspaceId) ?? "changed";
          if (contents === "unreadable")
            return Effect.fail(
              new WorkspaceError({ operation: "snapshot", message: "Unsafe workspace path." }),
            );
          if (contents === "changed" || record.status !== "active") return Effect.succeed(false);
          return confirm(
            contents === "undeletable"
              ? Effect.fail(
                  new WorkspaceError({
                    operation: "recovery",
                    message: "Editable workspace trees remain; discard is incomplete.",
                  }),
                )
              : save({ ...record, status: "discarded" }).pipe(Effect.asVoid),
          );
        }),
      ),
    inspect: ({ workspaceId }) => existing(workspaceId),
    list: ({ ownerId }) =>
      Effect.sync(() =>
        [...records.values()].filter((record) => record.handle.ownerId === ownerId),
      ),
    listAll: unused(),
  };
};

let nextSession = 1;

export const workflowSessionKey = (): string => `workflow-test-${process.pid}-${nextSession++}`;

export interface WorkflowFixtureOptions {
  readonly backend?: ReturnType<typeof fakeNativeReportBackendLayer>;
  readonly profiles?: ReturnType<typeof profileLayerFor>;
  readonly concurrency?: number;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly worktrees?: boolean;
  readonly accept?: (notification: SubagentWorkflowNotification) => boolean;
  readonly notify?: (
    notification: SubagentWorkflowNotification,
  ) => SubagentNotificationDelivery | undefined;
  readonly decorate?: (service: SubagentServiceContract) => SubagentServiceContract;
  readonly sessionKey?: string;
  readonly restart?: boolean;
  readonly runFiles?: MemoryRunFiles;
  readonly activity?: WorkflowActivitySink;
  readonly observer?: WorkflowRunObserver;
}

export const workflowFixture = (options: WorkflowFixtureOptions = {}) => {
  const backend = options.backend ?? fakeNativeReportBackendLayer();
  const subagents = nativeReportServiceFixture(backend, {}, options.profiles);
  const workers = new Map<string, FakeWorkerContents>();
  const createGates = new Map<string, FakeGate>();
  const checkGates = new Map<string, FakeGate>();
  const subagentLayer = options.worktrees
    ? subagents.layer.pipe(
        Layer.provide(
          Layer.succeed(
            WorkspaceService,
            creatingWorkspaceEngine(workers, createGates, checkGates),
          ),
        ),
      )
    : subagents.layer;
  const workflowNotifications: SubagentWorkflowNotification[] = [];
  const delivered: SubagentWorkflowNotification[] = [];
  const runFiles = options.runFiles ?? memoryRunFiles();
  const sessionKey = options.sessionKey ?? workflowSessionKey();
  const memoryKey = options.restart ? workflowSessionKey() : sessionKey;
  const decorate = options.decorate;
  const workflowSubagents = decorate
    ? Layer.effect(
        SubagentService,
        SubagentService.use((service) => Effect.succeed(decorate(service))),
      ).pipe(Layer.provide(subagentLayer))
    : subagentLayer;
  const layer = WorkflowService.layer({
    concurrency: options.concurrency ?? 4,
    sessionKey,
    ...(options.activity !== undefined && { activity: options.activity }),
    ...(options.observer !== undefined && { observer: options.observer }),
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
        WorkflowJournal.layer(memoryKey),
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
    workers,
    createGates,
    checkGates,
    layer,
  };
};

export type WorkflowFixture = ReturnType<typeof workflowFixture>;

export const withWorkflows = <A, E, R>(
  fixture: WorkflowFixture,
  body: (
    workflows: WorkflowServiceContract,
    subagents: SubagentServiceContract,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    return yield* body(yield* WorkflowService, yield* SubagentService);
  }).pipe(Effect.scoped, Effect.provide(fixture.layer));

export interface WorkflowTestContext {
  readonly fixture: WorkflowFixture;
  readonly workflows: WorkflowServiceContract;
  readonly subagents: SubagentServiceContract;
}

export const inWorkflows = <Eff extends Effect.Effect<unknown, unknown, unknown>, A>(
  fixture: WorkflowFixture,
  body: (context: WorkflowTestContext) => Generator<Eff, A, never>,
) =>
  withWorkflows(fixture, (workflows, subagents) =>
    Effect.gen(() => body({ fixture, workflows, subagents })),
  );

export const workflowTest = <Eff extends Effect.Effect<unknown, unknown, unknown>, A>(
  options: WorkflowFixtureOptions,
  body: (context: WorkflowTestContext) => Generator<Eff, A, never>,
) => inWorkflows(workflowFixture(options), body);

const liveClockWith = (overrides: (live: Clock.Clock) => Partial<Clock.Clock>) =>
  Clock.clockWith((live) =>
    Effect.succeed<Clock.Clock>({
      currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe(),
      currentTimeMillis: live.currentTimeMillis,
      currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
      currentTimeNanos: live.currentTimeNanos,
      monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: live.monotonicTimeNanos,
      sleep: (duration) => live.sleep(duration),
      ...overrides(live),
    }),
  );

export const stoppedWallClock = liveClockWith((live) => {
  const millis = live.currentTimeMillisUnsafe();
  return { currentTimeMillisUnsafe: () => millis, currentTimeMillis: Effect.succeed(millis) };
});

export const hurriedClock = (hurried: Duration.Input) =>
  liveClockWith((live) => ({
    sleep: (duration) =>
      live.sleep(
        Duration.isGreaterThanOrEqualTo(duration, Duration.minutes(1))
          ? Duration.fromInputUnsafe(hurried)
          : duration,
      ),
  }));

export const withJournal = <A>(
  session: string,
  use: (journal: WorkflowJournalContract) => Effect.Effect<A>,
) => WorkflowJournal.use(use).pipe(Effect.provide(WorkflowJournal.layer(session)));

export const onceSettled = <A>(
  operation: Effect.Effect<A, SubagentError>,
): Effect.Effect<A, SubagentError> =>
  operation.pipe(
    Effect.catchIf(
      (error) => subagentErrorCode(error) === "workspace_process_unsettled",
      () =>
        Effect.sleep("5 millis").pipe(Effect.andThen(Effect.suspend(() => onceSettled(operation)))),
    ),
  );

export const eventually = <A>(probe: () => A | undefined, label: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt++) {
      const value = probe();
      if (value !== undefined) return value;
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${label}.`));
  });

export const until = (condition: () => boolean, label: string) =>
  eventually(() => (condition() ? true : undefined), label);

export const runWhere = (
  workflows: WorkflowServiceContract,
  id: string,
  predicate: (run: WorkflowRunView) => boolean,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 4_000; attempt++) {
      const run = (yield* workflows.list).find((candidate) => candidate.id === id);
      if (run !== undefined && predicate(run)) return run;
      yield* Effect.sleep("2 millis");
    }
    return yield* Effect.die(new Error(`Timed out waiting for workflow ${id}.`));
  });

export const finished = (workflows: WorkflowServiceContract, id: string) =>
  runWhere(workflows, id, (run) => run.endedAt !== undefined);

export const deliveredFor = (fixture: WorkflowFixture, id: string) =>
  eventually(() => fixture.delivered.find((sent) => sent.runId === id), `${id}'s notification`);

const runsOf = (projections: ReadonlyArray<SubagentProjection>, task: string) =>
  projections.at(-1)?.runs.filter((run) => run.task === task) ?? [];

const runningRun = (projections: ReadonlyArray<SubagentProjection>, task: string) =>
  runsOf(projections, task).find((run) => run.state === "running");

export const reportTask = (fixture: WorkflowFixture, task: string, text: string) =>
  Effect.gen(function* () {
    const run = yield* eventually(
      () => runningRun(fixture.projections, task),
      `agent "${task}" to run`,
    );
    const control = yield* controlForTask(fixture, task);
    control.report(run.id, 1, `report-${run.id}`, text);
    return run.id;
  });

export const controlForTask = (fixture: WorkflowFixture, task: string) =>
  eventually(
    () =>
      fixture.backend.controls.findLast((candidate) =>
        candidate.prompts.some((prompt) => prompt.includes(`Assigned task:\n${task}\n\n`)),
      ),
    `agent "${task}" to receive its prompt`,
  );

export const leaveInWorktree = (
  fixture: WorkflowFixture,
  task: string,
  contents: FakeWorkerContents,
) =>
  Effect.gen(function* () {
    const workspaceId = yield* eventually(
      () => runningRun(fixture.projections, task)?.workspaceId,
      `worktree writer "${task}" to run`,
    );
    fixture.workers.set(workspaceId, contents);
    return workspaceId;
  });

export const runningTask = (fixture: WorkflowFixture, task: string) =>
  eventually(() => runningRun(fixture.projections, task)?.id, `agent "${task}" to run`);

export const stateOfTask = (fixture: WorkflowFixture, task: string) => {
  const runs = runsOf(fixture.projections, task);
  if (runs.length > 1) throw new Error(`Several agents received "${task}".`);
  return runs[0]?.state;
};

export { profileLayerFor, fakeNativeReportBackendLayer, nativeReportRequest };
