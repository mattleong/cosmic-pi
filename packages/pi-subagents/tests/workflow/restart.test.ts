// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WorkflowJournal, WORKFLOW_JOURNAL_MAX_CHARS } from "../../src/workflow/journal.ts";
import { WORKFLOW_RETAINED_RUNS } from "../../src/workflow/model.ts";
import { makeWorkflowRecovery } from "../../src/workflow/recovery.ts";
import { WORKFLOW_RESULT_LINE_MAX_CHARS } from "../../src/workflow/results.ts";
import type { WorkflowServiceContract, WorkflowStartError } from "../../src/workflow/service.ts";
import {
  eventually,
  finished,
  inline,
  journalLines,
  leaveInWorktree,
  memoryRunFiles,
  type MemoryRunFiles,
  memoryRunPaths,
  memoryStore,
  patchRunRecord,
  reportTask,
  resultValue,
  runningTask,
  runRecord,
  stateOfTask,
  testHost,
  withWorkflows,
  workflowFixture,
  workflowSessionKey,
} from "./fixtures/workflow-harness.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

/** A pid no process has: above every platform's pid range. */
const DEAD_PID = 99_999_999;

/**
 * A report within the backend's bound whose canonical JSON, every quote escaped, is too long for
 * a journal line.
 */
const longReport = (end: string) => `${'"'.repeat(WORKFLOW_RESULT_LINE_MAX_CHARS / 2 + 1)}${end}`;

const WORKTREE_WRITER = 'agent("edit", { profile: "worker", isolation: "worktree" })';

const FIND_AND_FIX = `
  const found = await agent("find bugs", { label: "finder" });
  const fixed = await agent("fix them", { label: "fixer" });`;

/** The start's refusal: its code and message. */
const refusal = <A>(start: Effect.Effect<A, WorkflowStartError>) =>
  Effect.flip(start).pipe(
    Effect.map((error) => ({
      code: error._tag === "WorkflowRequestError" ? error.code : error._tag,
      message: error.message,
    })),
  );

const resume = (workflows: WorkflowServiceContract, runId: string, body: string) =>
  workflows.start({ source: inline(body), args: null, resumeFromRunId: runId }, testHost());

const notifiedOnDisk = (files: MemoryRunFiles, runId: string) =>
  eventually(
    () => (runRecord(files, runId)?.["notified"] === true ? true : undefined),
    "the record to note the accepted notice",
  );

/** Runs FIND_AND_FIX to completion of both agents, then fails; returns the run id. */
const failAfterTwoAgents = (sessionKey: string, runFiles: MemoryRunFiles) => {
  const fixture = workflowFixture({ sessionKey, runFiles });
  return withWorkflows(fixture, (workflows) =>
    Effect.gen(function* () {
      const started = yield* workflows.start(
        { source: inline(`${FIND_AND_FIX}\nthrow new Error("not yet");`), args: null },
        testHost(),
      );
      yield* reportTask(fixture, "find bugs", "Two bugs.");
      yield* reportTask(fixture, "fix them", "Fixed both.");
      expect((yield* finished(workflows, started.id)).state).toBe("failed");
      yield* notifiedOnDisk(runFiles, started.id);
      return started.id;
    }),
  );
};

/** Starts a run whose first agent finishes and second still runs when the session tears down. */
const interruptWithOneFinished = (sessionKey: string, runFiles: MemoryRunFiles) => {
  const fixture = workflowFixture({ sessionKey, runFiles });
  return withWorkflows(fixture, (workflows) =>
    Effect.gen(function* () {
      const started = yield* workflows.start(
        { source: inline(`${FIND_AND_FIX}\nreturn fixed;`), args: null },
        testHost(),
      );
      yield* reportTask(fixture, "find bugs", "Two bugs.");
      yield* runningTask(fixture, "fix them");
      return started.id;
    }),
  );
};

/**
 * Plants a record of the session that the startup scan owes a notice and finds newest, so the
 * scan posts its notice last: once that arrives, the scan has posted every notice it owed.
 */
const plantSentinel = (files: MemoryRunFiles, sessionKey: string, runId: string) =>
  void files.records.set(
    runId,
    JSON.stringify({
      version: 1,
      runId,
      sessionKey,
      name: "sentinel",
      source: { kind: "inline" },
      pid: DEAD_PID,
      startedAt: 0,
      state: "interrupted",
      notified: false,
    }),
  );

/** The notices the fixture posted by the end of its startup scan, besides the sentinel's. */
const scannedNotices = (fixture: ReturnType<typeof workflowFixture>, sentinel: string) =>
  eventually(
    () =>
      fixture.workflowNotifications.some((notice) => notice.runId === sentinel) ? true : undefined,
    "the startup scan's last notice",
  ).pipe(
    Effect.map(() => fixture.workflowNotifications.filter((notice) => notice.runId !== sentinel)),
  );

/** Restarts the session and returns the notices its startup posted. */
const restartNotices = (sessionKey: string, runFiles: MemoryRunFiles, sentinel: string) => {
  plantSentinel(runFiles, sessionKey, sentinel);
  const restarted = workflowFixture({ sessionKey, runFiles, restart: true });
  return withWorkflows(restarted, () => scannedNotices(restarted, sentinel));
};

describe("resuming a workflow run after a Pi restart", () => {
  it.live("replays finished agents from the run's files with an empty memory", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    return Effect.gen(function* () {
      const runId = yield* failAfterTwoAgents(sessionKey, runFiles);
      const restarted = workflowFixture({ sessionKey, runFiles, restart: true });
      yield* withWorkflows(restarted, (workflows) =>
        Effect.gen(function* () {
          const resumed = yield* resume(
            workflows,
            runId,
            `${FIND_AND_FIX}\nreturn [found, fixed, await agent("verify")];`,
          );
          yield* reportTask(restarted, "verify", "Verified.");
          const done = yield* finished(workflows, resumed.id);
          expect(resultValue(done)).toEqual(["Two bugs.", "Fixed both.", "Verified."]);
          expect(done.reused).toBe(2);
          expect(stateOfTask(restarted, "find bugs")).toBeUndefined();
          expect(stateOfTask(restarted, "fix them")).toBeUndefined();
        }),
      );
    });
  });

  it.live("replays a result too long for its journal line from the file beside it", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    const long = longReport("-end");
    const first = workflowFixture({ sessionKey, runFiles });
    return Effect.gen(function* () {
      const runId = yield* withWorkflows(first, (workflows) =>
        Effect.gen(function* () {
          const started = yield* workflows.start(
            { source: inline('await agent("write it");\nthrow new Error("not yet");'), args: null },
            testHost(),
          );
          yield* reportTask(first, "write it", long);
          const done = yield* finished(workflows, started.id);
          const [line] = journalLines(runFiles, done.journalPath);
          expect(line).toMatchObject({ resultTruncated: true, resultFile: "results/1.json" });
          expect(line?.["result"]).not.toBe(long);
          return started.id;
        }),
      );
      const restarted = workflowFixture({ sessionKey, runFiles, restart: true });
      yield* withWorkflows(restarted, (workflows) =>
        Effect.gen(function* () {
          const resumed = yield* resume(
            workflows,
            runId,
            'const text = await agent("write it");\nreturn [text.length, text.slice(-4)];',
          );
          const done = yield* finished(workflows, resumed.id);
          expect(done.reused).toBe(1);
          expect(resultValue(done)).toEqual([long.length, "-end"]);
          expect(stateOfTask(restarted, "write it")).toBeUndefined();
        }),
      );
      // The reused result is saved in full again, so the resumed run can itself be resumed.
      expect([...runFiles.results.values()].map((text) => decodeJson(text))).toEqual([long, long]);
    });
  });

  it.live("runs an agent again when its long result couldn't be saved in full", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    runFiles.failResult = true;
    const long = longReport("");
    const first = workflowFixture({ sessionKey, runFiles });
    return Effect.gen(function* () {
      const runId = yield* withWorkflows(first, (workflows) =>
        Effect.gen(function* () {
          const started = yield* workflows.start(
            { source: inline('await agent("write it");\nthrow new Error("not yet");'), args: null },
            testHost(),
          );
          yield* reportTask(first, "write it", long);
          const done = yield* finished(workflows, started.id);
          expect(journalLines(runFiles, done.journalPath)).toEqual([
            expect.objectContaining({ resultTruncated: true, replayable: false }),
          ]);
          expect(done.warnings).toHaveLength(1);
          return started.id;
        }),
      );
      runFiles.failResult = false;
      const restarted = workflowFixture({ sessionKey, runFiles, restart: true });
      yield* withWorkflows(restarted, (workflows) =>
        Effect.gen(function* () {
          const resumed = yield* resume(workflows, runId, 'return await agent("write it");');
          yield* reportTask(restarted, "write it", "Shorter now.");
          const done = yield* finished(workflows, resumed.id);
          expect(done.reused).toBe(0);
          expect(done.result?.text).toBe("Shorter now.");
        }),
      );
    });
  });

  it.live("reads full results only within what one resume reads in all", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    const first = workflowFixture({ sessionKey, runFiles });
    return Effect.gen(function* () {
      const runId = yield* withWorkflows(first, (workflows) =>
        Effect.gen(function* () {
          const started = yield* workflows.start(
            {
              source: inline(
                'await agent("one");\nawait agent("two");\nthrow new Error("not yet");',
              ),
              args: null,
            },
            testHost(),
          );
          yield* reportTask(first, "one", longReport("-1"));
          yield* reportTask(first, "two", longReport("-2"));
          expect((yield* finished(workflows, started.id)).state).toBe("failed");
          yield* notifiedOnDisk(runFiles, started.id);
          return started.id;
        }),
      );
      // Each full result takes over half of what one resume reads, so only the first fits.
      expect(runFiles.results.size).toBe(2);
      for (const path of runFiles.results.keys())
        runFiles.results.set(path, `"${"x".repeat(WORKFLOW_JOURNAL_MAX_CHARS / 2 + 1)}"`);
      const restarted = workflowFixture({ sessionKey, runFiles, restart: true });
      yield* withWorkflows(restarted, (workflows) =>
        Effect.gen(function* () {
          const started = yield* resume(
            workflows,
            runId,
            'await agent("one");\nreturn await agent("two");',
          );
          yield* runningTask(restarted, "two");
          yield* reportTask(restarted, "two", "again");
          const done = yield* finished(workflows, started.id);
          expect(done.reused).toBe(1);
          expect(done.result?.text).toBe("again");
        }),
      );
    });
  });

  it.live("skips malformed journal lines and reuses the rest", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    return Effect.gen(function* () {
      const runId = yield* failAfterTwoAgents(sessionKey, runFiles);
      const journal = runFiles.journals.get(memoryRunPaths(runId).journal) ?? [];
      runFiles.journals.set(memoryRunPaths(runId).journal, [
        "not json",
        ...journal.slice(0, 1),
        '{"state":"completed","key":5,"outputTokens":1,"result":"forged"}',
        '{"state":"completed","outputTokens":-1,"result":null}',
        ...journal.slice(1),
      ]);
      const restarted = workflowFixture({ sessionKey, runFiles, restart: true });
      yield* withWorkflows(restarted, (workflows) =>
        Effect.gen(function* () {
          const resumed = yield* resume(
            workflows,
            runId,
            `${FIND_AND_FIX}\nreturn [found, fixed];`,
          );
          const done = yield* finished(workflows, resumed.id);
          expect(resultValue(done)).toEqual(["Two bugs.", "Fixed both."]);
          expect(done.reused).toBe(2);
        }),
      );
    });
  });

  it.live("refuses a run that another session recorded", () => {
    const runFiles = memoryRunFiles();
    return Effect.gen(function* () {
      const runId = yield* failAfterTwoAgents(workflowSessionKey(), runFiles);
      const other = workflowFixture({ sessionKey: workflowSessionKey(), runFiles, restart: true });
      const refused = yield* withWorkflows(other, (workflows) =>
        refusal(resume(workflows, runId, FIND_AND_FIX)),
      );
      expect(refused.code).toBe("resume_other_session");
      expect(other.backend.controls).toEqual([]);
    });
  });

  it.live("refuses a run that is still live in another Pi process", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    return Effect.gen(function* () {
      const runId = yield* failAfterTwoAgents(sessionKey, runFiles);
      // The parent of this test process is alive and isn't this process.
      patchRunRecord(runFiles, runId, { state: "running", pid: process.ppid, notified: false });
      plantSentinel(runFiles, sessionKey, "wf-sentinel-1");
      const restarted = workflowFixture({ sessionKey, runFiles, restart: true });
      const [refused, notices] = yield* withWorkflows(restarted, (workflows) =>
        Effect.all([
          refusal(resume(workflows, runId, FIND_AND_FIX)),
          scannedNotices(restarted, "wf-sentinel-1"),
        ]),
      );
      expect(refused.code).toBe("resume_running_elsewhere");
      // Its own process still reports it, so this one owes no notice.
      expect(notices).toEqual([]);
    });
  });

  it.live("resumes a run whose process id was reused after its heartbeat stopped", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    return Effect.gen(function* () {
      const runId = yield* failAfterTwoAgents(sessionKey, runFiles);
      // A crash left the record running; the pid now names a live process, but nothing has
      // refreshed the run's directory since.
      patchRunRecord(runFiles, runId, { state: "running", pid: process.ppid, notified: false });
      runFiles.writtenAt.set(runId, 0);
      const restarted = workflowFixture({ sessionKey, runFiles, restart: true });
      yield* withWorkflows(restarted, (workflows) =>
        Effect.gen(function* () {
          const notice = yield* eventually(() => restarted.delivered[0], "the interrupted notice");
          expect(notice).toMatchObject({ runId, outcome: "interrupted" });
          const resumed = yield* resume(
            workflows,
            runId,
            `${FIND_AND_FIX}\nreturn [found, fixed];`,
          );
          const done = yield* finished(workflows, resumed.id);
          expect(done.reused).toBe(2);
        }),
      );
    });
  });

  it.live("says a run whose files are gone may have been pruned", () => {
    const restarted = workflowFixture({ restart: true });
    return withWorkflows(restarted, (workflows) =>
      Effect.gen(function* () {
        const refused = yield* refusal(resume(workflows, "wf-gone-1", FIND_AND_FIX));
        expect(refused.code).toBe("resume_unknown");
      }),
    );
  });

  it.live("tells a run that couldn't save its record apart from a pruned one", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    runFiles.failRecord = true;
    const first = workflowFixture({ sessionKey, runFiles });
    return Effect.gen(function* () {
      const runId = yield* withWorkflows(first, (workflows) =>
        Effect.gen(function* () {
          const started = yield* workflows.start(
            { source: inline('throw new Error("not yet");'), args: null },
            testHost(),
          );
          yield* finished(workflows, started.id);
          return started.id;
        }),
      );
      runFiles.failRecord = false;
      const restarted = workflowFixture({ sessionKey, runFiles, restart: true });
      const refused = yield* withWorkflows(restarted, (workflows) =>
        refusal(resume(workflows, runId, FIND_AND_FIX)),
      );
      expect(refused.code).toBe("resume_unrecorded");
    });
  });

  it.live("tells a run whose record is unreadable apart from an unknown one", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    return Effect.gen(function* () {
      const runId = yield* failAfterTwoAgents(sessionKey, runFiles);
      patchRunRecord(runFiles, runId, { version: 99 });
      const restarted = workflowFixture({ sessionKey, runFiles, restart: true });
      const refused = yield* withWorkflows(restarted, (workflows) =>
        refusal(resume(workflows, runId, FIND_AND_FIX)),
      );
      expect(refused.code).toBe("resume_unreadable");
    });
  });
});

describe("workflow runs a restart interrupted", () => {
  it.live("are announced once after the restart, and not after the next one", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    return Effect.gen(function* () {
      const runId = yield* interruptWithOneFinished(sessionKey, runFiles);
      // The teardown marked the run interrupted before Pi exited.
      expect(runRecord(runFiles, runId)).toMatchObject({ state: "interrupted", notified: false });

      const notices = yield* restartNotices(sessionKey, runFiles, "wf-sentinel-1");
      expect(notices).toEqual([
        expect.objectContaining({
          runId,
          outcome: "interrupted",
          agents: expect.objectContaining({ total: 1 }),
        }),
      ]);
      expect(notices[0]?.content).toContain(`resumeFromRunId: "${runId}"`);
      expect(runRecord(runFiles, runId)).toMatchObject({ notified: true });

      expect(yield* restartNotices(sessionKey, runFiles, "wf-sentinel-2")).toEqual([]);
    });
  });

  it.live("are announced when their Pi process died while they ran", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    return Effect.gen(function* () {
      const runId = yield* interruptWithOneFinished(sessionKey, runFiles);
      // A crash leaves the record running under a process that is gone.
      patchRunRecord(runFiles, runId, { state: "running", pid: DEAD_PID });
      expect(yield* restartNotices(sessionKey, runFiles, "wf-sentinel-1")).toEqual([
        expect.objectContaining({ runId, outcome: "interrupted" }),
      ]);
      expect(runRecord(runFiles, runId)).toMatchObject({ state: "interrupted", notified: true });
      expect(yield* restartNotices(sessionKey, runFiles, "wf-sentinel-2")).toEqual([]);
    });
  });

  it.live("are announced when Pi exited before accepting their report", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    const first = workflowFixture({ sessionKey, runFiles, accept: () => false });
    return Effect.gen(function* () {
      const runId = yield* withWorkflows(first, (workflows) =>
        Effect.gen(function* () {
          const started = yield* workflows.start(
            { source: inline(`${FIND_AND_FIX}\nreturn fixed;`), args: null },
            testHost(),
          );
          yield* reportTask(first, "find bugs", "Two bugs.");
          yield* reportTask(first, "fix them", "Fixed both.");
          yield* finished(workflows, started.id);
          yield* eventually(() => first.workflowNotifications[0], "the refused report");
          return started.id;
        }),
      );
      expect(runRecord(runFiles, runId)).toMatchObject({ state: "completed", notified: false });
      // While the live process that ended the run still delivers its report, nothing is owed.
      patchRunRecord(runFiles, runId, { pid: process.ppid });
      expect(yield* restartNotices(sessionKey, runFiles, "wf-sentinel-1")).toEqual([]);
      patchRunRecord(runFiles, runId, { pid: DEAD_PID });
      expect(yield* restartNotices(sessionKey, runFiles, "wf-sentinel-2")).toEqual([
        expect.objectContaining({ runId, outcome: "interrupted" }),
      ]);
      expect(yield* restartNotices(sessionKey, runFiles, "wf-sentinel-3")).toEqual([]);
    });
  });

  it.live("say how a run ended when Pi never accepted its report", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    const first = workflowFixture({ sessionKey, runFiles, accept: () => false });
    return Effect.gen(function* () {
      const runId = yield* withWorkflows(first, (workflows) =>
        Effect.gen(function* () {
          const started = yield* workflows.start(
            { source: inline('throw new Error("broken");'), args: null },
            testHost(),
          );
          yield* finished(workflows, started.id);
          yield* eventually(() => first.workflowNotifications[0], "the refused report");
          return started.id;
        }),
      );
      // This process remembers how the run ended, and a later one reads it from the record.
      const remembered = yield* WorkflowJournal.use((journal) => journal.interruptedRuns).pipe(
        Effect.provide(WorkflowJournal.layer(sessionKey)),
      );
      expect(remembered).toEqual([expect.objectContaining({ runId, ended: "failed" })]);
      patchRunRecord(runFiles, runId, { pid: DEAD_PID });
      const recovery = makeWorkflowRecovery({ store: memoryStore({}, runFiles), sessionKey });
      expect(yield* recovery.interrupted(() => Effect.succeed(false))).toEqual([
        expect.objectContaining({ runId, ended: "failed", restarted: true }),
      ]);
    });
  });

  it.live("are announced however many runs other sessions recorded since", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    return Effect.gen(function* () {
      const runId = yield* interruptWithOneFinished(sessionKey, runFiles);
      const otherSession = workflowSessionKey();
      for (let ordinal = 1; ordinal <= WORKFLOW_RETAINED_RUNS + 1; ordinal++)
        plantSentinel(runFiles, otherSession, `wf-other-${ordinal}`);
      expect(yield* restartNotices(sessionKey, runFiles, "wf-sentinel-1")).toEqual([
        expect.objectContaining({ runId, outcome: "interrupted" }),
      ]);
    });
  });

  it.live("leave the runs another session recorded alone", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    plantSentinel(runFiles, workflowSessionKey(), "wf-other-1");
    plantSentinel(runFiles, sessionKey, "wf-sentinel-1");
    const restarted = workflowFixture({ sessionKey, runFiles, restart: true });
    return withWorkflows(restarted, (workflows) =>
      Effect.gen(function* () {
        expect(yield* scannedNotices(restarted, "wf-sentinel-1")).toEqual([]);
        const other = yield* Effect.flip(workflows.status("wf-other-1"));
        expect(other._tag).toBe("WorkflowNotFoundError");
      }),
    );
  });

  it.live("don't offer a restart for a run someone was stopping", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    return Effect.gen(function* () {
      const runId = yield* interruptWithOneFinished(sessionKey, runFiles);
      patchRunRecord(runFiles, runId, { stoppedBy: "user" });
      const notices = yield* restartNotices(sessionKey, runFiles, "wf-sentinel-1");
      expect(notices).toEqual([expect.objectContaining({ runId, outcome: "interrupted" })]);
      expect(notices[0]?.content).not.toContain("resumeFromRunId");
    });
  });

  it.live("are announced from memory on a reload, which also marks their record", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    return Effect.gen(function* () {
      const runId = yield* interruptWithOneFinished(sessionKey, runFiles);
      plantSentinel(runFiles, sessionKey, "wf-sentinel-1");
      const reloaded = workflowFixture({ sessionKey, runFiles });
      const notices = yield* withWorkflows(reloaded, () =>
        scannedNotices(reloaded, "wf-sentinel-1"),
      );
      expect(notices).toEqual([expect.objectContaining({ runId, outcome: "interrupted" })]);
      yield* notifiedOnDisk(runFiles, runId);
      expect(yield* restartNotices(sessionKey, runFiles, "wf-sentinel-2")).toEqual([]);
    });
  });

  it.live("aren't announced from memory once another Pi process of the session did", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    return Effect.gen(function* () {
      const runId = yield* interruptWithOneFinished(sessionKey, runFiles);
      // Another Pi process of the session posted the notice and noted it in the record.
      patchRunRecord(runFiles, runId, { notified: true });
      plantSentinel(runFiles, sessionKey, "wf-sentinel-1");
      const reloaded = workflowFixture({ sessionKey, runFiles });
      expect(
        yield* withWorkflows(reloaded, () => scannedNotices(reloaded, "wf-sentinel-1")),
      ).toEqual([]);
      // Memory closed the run instead, so later reloads leave it alone too.
      const remembered = yield* WorkflowJournal.use((journal) => journal.interruptedRuns).pipe(
        Effect.provide(WorkflowJournal.layer(sessionKey)),
      );
      expect(remembered).toEqual([]);
    });
  });

  it.live("aren't confused with runs that finished and were reported", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    return Effect.gen(function* () {
      const runId = yield* failAfterTwoAgents(sessionKey, runFiles);
      expect(runRecord(runFiles, runId)).toMatchObject({ state: "failed", notified: true });
      expect(yield* restartNotices(sessionKey, runFiles, "wf-sentinel-1")).toEqual([]);
    });
  });

  it.live("name the worktree of a writer still running when the session tore down", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    const first = workflowFixture({ sessionKey, runFiles, worktrees: true });
    return Effect.gen(function* () {
      const { runId, workspaceId } = yield* withWorkflows(first, (workflows) =>
        Effect.gen(function* () {
          const started = yield* workflows.start(
            { source: inline(`return ${WORKTREE_WRITER};`), args: null },
            testHost(),
          );
          return {
            runId: started.id,
            workspaceId: yield* leaveInWorktree(first, "edit", "changed"),
          };
        }),
      );
      const notices = yield* restartNotices(sessionKey, runFiles, "wf-sentinel-1");
      expect(notices).toEqual([
        expect.objectContaining({ runId, outcome: "interrupted", workspaces: [workspaceId] }),
      ]);
    });
  });

  it.live("name the worktree of a writer skipped while it ran", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    const first = workflowFixture({ sessionKey, runFiles, worktrees: true });
    return Effect.gen(function* () {
      const { runId, workspaceId } = yield* withWorkflows(first, (workflows) =>
        Effect.gen(function* () {
          const started = yield* workflows.start(
            {
              source: inline(`await ${WORKTREE_WRITER};\nreturn await agent("next");`),
              args: null,
            },
            testHost(),
          );
          const workspaceId = yield* leaveInWorktree(first, "edit", "changed");
          yield* workflows.skip(yield* runningTask(first, "edit"));
          // The run goes on, so the next agent still runs when the session tears down.
          yield* runningTask(first, "next");
          return { runId: started.id, workspaceId };
        }),
      );
      const notices = yield* restartNotices(sessionKey, runFiles, "wf-sentinel-1");
      expect(notices).toEqual([
        expect.objectContaining({ runId, outcome: "interrupted", workspaces: [workspaceId] }),
      ]);
    });
  });

  it.live("show a read-only summary from their files in status", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    return Effect.gen(function* () {
      const runId = yield* interruptWithOneFinished(sessionKey, runFiles);
      const restarted = workflowFixture({ sessionKey, runFiles, restart: true });
      yield* withWorkflows(restarted, (workflows) =>
        Effect.gen(function* () {
          const status = yield* workflows.status(runId);
          expect(status).toMatchObject({
            kind: "recorded",
            run: {
              id: runId,
              state: "interrupted",
              finished: 1,
              scriptPath: memoryRunPaths(runId).script,
              journalPath: memoryRunPaths(runId).journal,
            },
          });
          const unknown = yield* Effect.flip(workflows.status("wf-gone-1"));
          expect(unknown._tag).toBe("WorkflowNotFoundError");
        }),
      );
    });
  });
});

describe("a workflow run's record", () => {
  it.live("names the session and process, and records the run's end and its report", () => {
    const sessionKey = workflowSessionKey();
    const runFiles = memoryRunFiles();
    const fixture = workflowFixture({ sessionKey, runFiles });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          { source: inline("return 1;"), args: null },
          testHost(),
        );
        yield* finished(workflows, started.id);
        yield* notifiedOnDisk(runFiles, started.id);
        const record = runRecord(runFiles, started.id);
        expect(record).toMatchObject({
          runId: started.id,
          sessionKey,
          pid: process.pid,
          source: { kind: "inline" },
          scriptPath: memoryRunPaths(started.id).script,
          state: "completed",
          endedAt: expect.any(Number),
          notified: true,
        });
      }),
    );
  });

  it.live("can't be saved without stopping the run, which logs one warning", () => {
    const runFiles = memoryRunFiles();
    runFiles.failRecord = true;
    const fixture = workflowFixture({ runFiles });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          { source: inline('return await agent("work");'), args: null },
          testHost(),
        );
        yield* reportTask(fixture, "work", "Done.");
        const done = yield* finished(workflows, started.id);
        expect(done.state).toBe("completed");
        expect(done.result?.text).toBe("Done.");
        expect(done.warnings).toHaveLength(1);
        expect(runFiles.records.size).toBe(0);
      }),
    );
  });
});
