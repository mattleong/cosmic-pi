// Explicit test entry-point Layer provision owns each scoped service runtime.
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import type {
  SubagentNotificationDelivery,
  SubagentWorkflowNotification,
} from "../../../src/boundary/host-notifier.ts";
import type { StartSubagentRequest, SubagentProjection } from "../../../src/run/model.ts";
import { SubagentService, type SubagentServiceContract } from "../../../src/run/service.ts";
import { WorkflowRunFileError } from "../../../src/boundary/workflow-run-files.ts";
import {
  WorkspaceError,
  type WorkspaceRecord,
  type WorkspaceSettledTarget,
} from "../../../src/workspace/model.ts";
import { WorkspaceService, type WorkspaceServiceContract } from "../../../src/workspace/service.ts";
import {
  WorkflowAgentCallError,
  type WorkflowAgentAccess,
  type WorkflowAgentSpec,
  type WorkflowHost,
} from "../../../src/workflow/agent.ts";
import { WorkflowJournal } from "../../../src/workflow/journal.ts";
import type { WorkflowRunView } from "../../../src/workflow/model.ts";
import type { WorkflowActivitySink } from "../../../src/workflow/runs.ts";
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

/** An inline workflow source with a complete script around the given body. */
export const inline = (body: string, name?: string) => ({
  kind: "inline" as const,
  script: script(body, name),
});

/** Starts root children of the main agent, which hold root slots until they report. */
export const mainChildren = (subagents: SubagentServiceContract, names: ReadonlyArray<string>) =>
  Effect.forEach(names, (name) => subagents.start(nativeReportRequest({ name, task: name })));

const writes = (spec: WorkflowAgentSpec): boolean =>
  spec.profile === "worker" || spec.writes !== undefined;

/** Resolves every agent to a native-report launch; `worker` and `writes` make it a writer. */
export const testHost = (
  record: (request: StartSubagentRequest) => void = () => {},
): WorkflowHost => ({
  checkAgent: (spec) => {
    if (spec.profile === "unknown")
      return Effect.fail(
        new WorkflowAgentCallError({ message: 'Unknown agent() profile "unknown".' }),
      );
    const access: WorkflowAgentAccess = writes(spec) ? "writer" : "read-only";
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

/** Run files kept in memory, with switches that make writing them fail. */
export interface MemoryRunFiles {
  /** Saved script copies by run id. */
  readonly scripts: Map<string, string>;
  /** Results journal lines by journal path. */
  readonly journals: Map<string, string[]>;
  /** `run.json` texts by run id, in the order runs were first recorded. */
  readonly records: Map<string, string>;
  /** Full results saved beside a journal, by path. */
  readonly results: Map<string, string>;
  /** When each run's directory was last written, its heartbeat, by run id. */
  readonly writtenAt: Map<string, number>;
  /** The live runs each creation was told not to prune. */
  readonly live: Array<ReadonlySet<string>>;
  failCreate: boolean;
  failAppend: boolean;
  failRecord: boolean;
  failResult: boolean;
  /** The next append writes its line, then waits on this, still holding the journal lock. */
  holdNextAppend: Effect.Effect<void> | undefined;
  /** Run directories marked recent, in order. */
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

/** The decoded results journal lines a run wrote. */
export const journalLines = (files: MemoryRunFiles, path: string | undefined) =>
  (path === undefined ? [] : (files.journals.get(path) ?? [])).map((line) => decodeLine(line));

const decodeLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

/** A run's saved `run.json`, decoded; undefined before the run is recorded. */
export const runRecord = (files: MemoryRunFiles, runId: string) => {
  const text = files.records.get(runId);
  return text === undefined ? undefined : decodeLine(text);
};

/** Rewrites a run's saved record, as another Pi process or a crash would leave it. */
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

/** Where the memory store keeps a run's files. */
export const memoryRunPaths = (runId: string) => {
  const directory = `/agent/subagents/workflow-runs/${runId}`;
  return {
    directory,
    script: `${directory}/script.js`,
    journal: `${directory}/journal.jsonl`,
    record: `${directory}/run.json`,
  };
};

/** Where the memory store says saved workflows live. */
export const memoryLocations = {
  project: "/project/.pi/workflows",
  projectTrusted: false,
  user: "/agent/workflows",
};

/** The script file's name without its directory, as the store's errors name it. */
const fileName = (path: string): string => path.split("/").at(-1) ?? path;

/**
 * A script file read from memory, failing like the real store's read: the full path leads the
 * agent-facing message, and the error names the file.
 */
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

/**
 * Saved workflows and script files from memory: `scripts` holds saved workflows by name and
 * script files by absolute path.
 */
export const memoryStore = (
  scripts: Readonly<Record<string, string>>,
  files: MemoryRunFiles = memoryRunFiles(),
): WorkflowStoreContract => {
  const runIdOf = (paths: { readonly directory: string }) =>
    paths.directory.split("/").at(-1) ?? "";
  /** Writing in a run's directory marks it recent, as the file system's times do. */
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

/**
 * What a settled writer left in its worktree, as the fake engine's check for changes finds it:
 * changes (the default), nothing, or a check or discard that fails.
 */
export type FakeWorkerContents = "changed" | "unchanged" | "unreadable" | "undeletable";

/** Holds a workspace operation once it starts, until `release` completes. */
export interface FakeGate {
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

export const fakeGate: Effect.Effect<FakeGate> = Effect.all({
  entered: Deferred.make<void>(),
  release: Deferred.make<void>(),
});

/** Notes that the gated operation started, then waits for its release. */
const passGate = (gate: FakeGate | undefined): Effect.Effect<void> =>
  gate
    ? Deferred.succeed(gate.entered, undefined).pipe(Effect.andThen(Deferred.await(gate.release)))
    : Effect.void;

/**
 * A workspace engine that creates isolated checkouts, `workspace-1` onwards, and keeps each one's
 * record through review, preparation, integration and discard, with a one-page diff per revision.
 * `workers` says what each worker holds when it is checked for changes. `createGates` holds the
 * creation of the workspaces listed there, and `checkGates` their checks for changes.
 */
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
    recoverDiscard: unused,
    inspect: ({ workspaceId }) => existing(workspaceId),
    list: ({ ownerId }) =>
      Effect.sync(() =>
        [...records.values()].filter((record) => record.handle.ownerId === ownerId),
      ),
    listAll: unused,
  };
};

/** An admission revision whose waiters wake on each release, as the subagent service's do. */
export const fakeAdmissionSignal = () => {
  let revision = 0;
  let changed = Deferred.makeUnsafe<void>();
  return {
    admissionRevision: Effect.sync(() => revision),
    waitForAdmissionChange: (after: number) =>
      Effect.suspend(() => (after < revision ? Effect.void : Deferred.await(changed))),
    /** Advances the revision synchronously, as a release under the run lock does. */
    releaseUnsafe: () => {
      revision += 1;
      const settled = changed;
      changed = Deferred.makeUnsafe();
      Deferred.doneUnsafe(settled, Effect.void);
    },
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
  /**
   * Starts with an empty resume memory for the session, like a new Pi process; run files shared
   * through `runFiles` still carry over.
   */
  readonly restart?: boolean;
  /** Where runs save their script and results journal. */
  readonly runFiles?: MemoryRunFiles;
  /** The host's Activity bridge, which sees coalesced publishes. */
  readonly activity?: WorkflowActivitySink;
}

/** The real subagent service over a native-report backend, plus the workflow service. */
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
  // A new Pi process remembers nothing; only the run files tie it to the session.
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
    /** What each worktree's worker holds when it is checked for changes, by workspace id. */
    workers,
    /** Workspace creations held until released, by the workspace id they create. */
    createGates,
    /** Checks for changes held until released, by workspace id. */
    checkGates,
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

/**
 * The live clock with its wall-clock milliseconds stopped, so everything reads the same time;
 * nanoseconds and sleeps stay live for the runtime's own timers.
 */
export const stoppedWallClock = Effect.gen(function* () {
  const live = yield* Clock.Clock;
  const millis = live.currentTimeMillisUnsafe();
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => millis,
    currentTimeMillis: Effect.succeed(millis),
    currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
    currentTimeNanos: live.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: live.monotonicTimeNanos,
    sleep: (duration) => live.sleep(duration),
  };
  return clock;
});

/**
 * The live clock with every sleep of a minute or more cut to `hurried`, so periodic work such as
 * a live run's directory refresh repeats quickly; shorter sleeps stay live.
 */
export const hurriedClock = (hurried: Duration.Input) =>
  Effect.gen(function* () {
    const live = yield* Clock.Clock;
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe(),
      currentTimeMillis: live.currentTimeMillis,
      currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
      currentTimeNanos: live.currentTimeNanos,
      monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: live.monotonicTimeNanos,
      sleep: (duration) =>
        live.sleep(
          Duration.isGreaterThanOrEqualTo(duration, Duration.minutes(1))
            ? Duration.fromInputUnsafe(hurried)
            : duration,
        ),
    };
    return clock;
  });

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

/**
 * The first view of a run that satisfies `predicate`, polled from the service's run list on real
 * time. Tests wait only for states that hold until the test acts again.
 */
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

/**
 * Waits until the worktree writer with `task` is running, then sets what its worker will hold
 * when it is checked for changes; returns its workspace id.
 */
export const leaveInWorktree = (
  fixture: ReturnType<typeof workflowFixture>,
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

/** Waits until the agent with `task` is running and returns its subagent run id. */
export const runningTask = (fixture: ReturnType<typeof workflowFixture>, task: string) =>
  eventually(() => runningRun(fixture.projections, task)?.id, `agent "${task}" to run`);

/** The state of the only subagent run that received `task`. */
export const stateOfTask = (fixture: ReturnType<typeof workflowFixture>, task: string) => {
  const runs = runsOf(fixture.projections, task);
  if (runs.length > 1) throw new Error(`Several agents received "${task}".`);
  return runs[0]?.state;
};

export { profileLayerFor, fakeNativeReportBackendLayer, nativeReportRequest };
