import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type {
  BackendDriver,
  BackendEvent,
  BackendHandle,
  BackendLaunchRequest,
} from "../../../src/backend/model.ts";
import type { ReportArchive, ReportArchiveEntry } from "../../../src/boundary/report-archive.ts";
import { WriterLeaseService } from "../../../src/boundary/writer-lease.ts";
import { SubagentNotFoundError } from "../../../src/run/errors.ts";
import type { RunContext, RunRecord } from "../../../src/run/internal.ts";
import type { SubagentRunView } from "../../../src/run/model.ts";
import type { RunNotificationDelivery } from "../../../src/run/notification-delivery.ts";
import { WriterPools } from "../../../src/run/writer-pool.ts";
import { settlementOperations } from "../../../src/run/settlement.ts";
import { view } from "../../fixtures/run-view.ts";
import { fakeWriterLeaseLayer } from "./service-harness.ts";
import { emptySessionUsageLedger } from "../../../src/run/session-usage.ts";

export const makeRunContext = (overrides: Partial<RunContext> = {}) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const records = overrides.records ?? new Map<string, RunRecord>();
    let attempts = 0;
    const context: RunContext = {
      ownerScope: yield* Scope.Scope,
      withLock: lock.withPermits(1),
      publish: Effect.void,
      records,
      writerPools: new WriterPools(),
      writerLeases: yield* WriterLeaseService,
      requireRecord: (id) => {
        const record = records.get(id);
        return record
          ? Effect.succeed(record)
          : Effect.fail(
              SubagentNotFoundError.make({ id, message: `Subagent run not found: ${id}` }),
            );
      },
      sendPeerNotices: () => Effect.void,
      allocateAssignmentAttemptToken: () => `assignment-test-${++attempts}`,
      sessionUsage: emptySessionUsageLedger(),
      ...overrides,
    };
    return context;
  }).pipe(Effect.provide(fakeWriterLeaseLayer()));

const unexpectedDelivery = (): never => {
  throw new Error("Unexpected run notification delivery in this fixture.");
};

const inertDelivery: RunNotificationDelivery = {
  deliverPendingCompletions: Effect.sync(unexpectedDelivery),
  queueActionNotificationLocked: unexpectedDelivery,
  insertCompletionLocked: unexpectedDelivery,
  wakeCompletionLocked: unexpectedDelivery,
  discardQuestionLocked: unexpectedDelivery,
  outboxChangedLocked: unexpectedDelivery,
  signalOutboxChangedLocked: unexpectedDelivery,
};

export const makeTestSettlement = (overrides: Partial<RunContext> = {}) =>
  makeRunContext(overrides).pipe(
    Effect.map((context) =>
      settlementOperations({
        ...context,
        delivery: inertDelivery,
        closeRecordScope: () => Effect.void,
        claimTurnInputDrain: (_record, drained) => Deferred.doneUnsafe(drained, Effect.void),
      }),
    ),
  );

const inertDriver: BackendDriver = {
  runtime: "pi",
  capabilities: [],
  supportsContext: () => true,
  preflight: () => Effect.void,
  spawn: () => Effect.die("unused"),
};

const launchFixture: BackendLaunchRequest = {
  runId: "agent-1",
  name: "agent-1",
  cwd: "/project",
  context: "fresh",
  writeIntent: "read-only",
  openaiFastMode: false,
  model: "test/model",
  effort: "high",
  activeTools: [],
  projectTrusted: true,
  parentSessionId: "parent",
  systemPrompt: "",
};

export const backendHandleFixture = (overrides: Partial<BackendHandle> = {}) =>
  Effect.gen(function* () {
    const handle: BackendHandle = {
      events: yield* Queue.unbounded<BackendEvent, Cause.Done>(),
      awaitExit: Effect.never,
      controls: {
        initialize: Effect.succeed({ effort: "high", sessionId: "fixture" }),
        start: () => Effect.void,
        steer: () => Effect.void,
        interrupt: Effect.void,
        reply: () => Effect.void,
        notifyPeers: () => Effect.void,
      },
      acknowledge: () => {},
      terminate: () => Effect.void,
      cancelPending: () => {},
      ...overrides,
    };
    return handle;
  });

/** A record whose launch, assignment, and warnings hold what the given view shows. */
export const runRecordFixture = (
  overrides: Partial<Omit<RunRecord, "view">> & { readonly view?: SubagentRunView } = {},
) =>
  Effect.gen(function* () {
    const { view: shown = view(), ...rest } = overrides;
    const {
      name,
      assignmentEpoch,
      warning: _warning,
      warningSource,
      childWarning,
      systemWarning,
      ...stored
    } = shown;
    const record: RunRecord = {
      scriptOrigin: false,
      view: stored,
      scope: yield* Scope.make(),
      driver: inertDriver,
      launch: { ...launchFixture, name },
      activeTools: new Map(),
      nativeAgents: new Set(),
      cleanupSettlement: yield* Deferred.make<"confirmed" | "quarantined">(),
      cleanupDisposition: "none",
      pauseRequested: false,
      stoppedByParent: false,
      runStateReclaimState: "pending",
      notificationGeneration: 0,
      completionGeneration: 0,
      warningSlots: { child: childWarning, system: systemWarning, latest: warningSource },
      completionGenerations: new Map(),
      completionClaims: new Map(),
      assignment: {
        epoch: assignmentEpoch,
        phase: "preparing",
        attemptToken: "fixture",
        startedObserved: false,
        outcomeUncertain: false,
        pendingRunSettled: false,
      },
      nextAssignmentEpoch: assignmentEpoch + 1,
      ...rest,
    };
    return record;
  });

export const runningAssignment = (epoch: number): RunRecord["assignment"] => ({
  epoch,
  phase: "running",
  attemptToken: "current",
  startedObserved: true,
  outcomeUncertain: false,
  pendingRunSettled: false,
});

/** A report archive whose saves wait for the test's release, recording what it saved and discarded. */
export const gatedReportArchive = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const saved: Array<ReportArchiveEntry> = [];
  const discarded: Array<string> = [];
  const archive: ReportArchive = {
    save: (entry) =>
      Effect.gen(function* () {
        saved.push(entry);
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        return {
          path: `/archive/${saved.length}.md`,
          chars: entry.text.length,
          lines: 1,
          complete: true,
        };
      }),
    discard: (file) => Effect.sync(() => void discarded.push(file.path)),
  };
  return { archive, entered, release, saved, discarded };
});
