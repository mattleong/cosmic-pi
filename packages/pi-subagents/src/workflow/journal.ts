import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import { WORKFLOW_RETAINED_RUNS, type WorkflowEndedState, type WorkflowSource } from "./model.ts";

/** Sessions whose journals one Pi process keeps. */
const WORKFLOW_JOURNAL_SESSIONS = 16;
/**
 * Total result text one session's journals may hold before the oldest runs are dropped, and what
 * a resume reads from one run's files.
 */
export const WORKFLOW_JOURNAL_MAX_CHARS = 16 * 1024 * 1024;

export interface WorkflowJournalEntry {
  readonly key: string;
  readonly result: Schema.Json;
  readonly outputTokens: number;
  readonly chars: number;
  /** A writer's worktree, which a run reusing this result still has to report for review. */
  readonly workspaceId?: string | undefined;
  readonly label?: string | undefined;
  /** The subagent run that produced the result, which a reusing run's results journal names. */
  readonly runId?: string | undefined;
}

/** Per-key FIFO over an earlier run's results. */
export interface WorkflowReplay {
  readonly take: (key: string) => WorkflowJournalEntry | undefined;
}

/** What a run starts again from: its source, and its private script copy once saved. */
interface WorkflowRunOrigin {
  readonly source: WorkflowSource;
  readonly scriptPath?: string | undefined;
}

/**
 * A run an earlier activation left running when the session was torn down, or that ended
 * without Pi accepting its report.
 */
export interface WorkflowInterruptedRun {
  readonly runId: string;
  readonly name: string;
  /** Agents that finished with a result, which a resume reuses. */
  readonly finished: number;
  /** Worktrees its writers created, finished or not. */
  readonly workspaces: ReadonlyArray<string>;
  /** Someone asked the run to stop before the teardown, so it isn't offered for a restart. */
  readonly stopped?: boolean | undefined;
  /** The run ended this way, but Pi never accepted its report. */
  readonly ended?: WorkflowEndedState | undefined;
  /** Where a restart starts the run again from. */
  readonly origin: WorkflowRunOrigin;
  /**
   * A later Pi process found the run in its files after a restart, rather than this process
   * remembering its teardown.
   */
  readonly restarted?: boolean | undefined;
}

export interface WorkflowJournalContract {
  /**
   * Registers a running run so it can be resumed even before it records a result, with where a
   * restart starts it again from.
   */
  readonly open: (runId: string, name: string, origin: WorkflowRunOrigin) => Effect.Effect<void>;
  readonly record: (runId: string, entry: WorkflowJournalEntry) => Effect.Effect<void>;
  /** Notes a worktree one of the run's writers works in. */
  readonly noteWorkspace: (runId: string, workspaceId: string) => Effect.Effect<void>;
  /** Forgets a noted worktree that was discarded because it held no changes. */
  readonly dropWorkspace: (runId: string, workspaceId: string) => Effect.Effect<void>;
  /** Notes that someone asked the run to stop; a teardown before its report keeps that fact. */
  readonly noteStop: (runId: string) => Effect.Effect<void>;
  /** Notes how the run ended, which a teardown before its report was accepted keeps. */
  readonly noteEnded: (runId: string, state: WorkflowEndedState) => Effect.Effect<void>;
  /**
   * Closes a run once its report was accepted, or when it needs none. A run still open at
   * teardown is reported by the next activation of the session.
   */
  readonly finish: (runId: string) => Effect.Effect<void>;
  /** A replay of the run's results, or undefined when the run is unknown to this session. */
  readonly replay: (runId: string) => Effect.Effect<WorkflowReplay | undefined>;
  /** Whether the session's memory holds the run, open or closed. */
  readonly has: (runId: string) => Effect.Effect<boolean>;
  /**
   * Runs an earlier activation of this session left open. Each stays open until `finish` records
   * that its notice was accepted, so a notice lost to another teardown is posted again. Read it
   * before this activation opens runs of its own.
   */
  readonly interruptedRuns: Effect.Effect<ReadonlyArray<WorkflowInterruptedRun>>;
}

interface RunJournal {
  readonly name: string;
  readonly origin: WorkflowRunOrigin;
  readonly entries: WorkflowJournalEntry[];
  readonly workspaces: Set<string>;
  /** Open until its outcome, or a later activation's notice about the teardown, is accepted. */
  open: boolean;
  stopped: boolean;
  ended?: WorkflowEndedState | undefined;
  /** Order in which runs closed; the newest closed run is never trimmed. Zero while open. */
  closedOrder: number;
}

type SessionJournals = Map<string, RunJournal>;

interface JournalSlot {
  readonly version: 3;
  readonly sessions: Map<string, SessionJournals>;
}

const JOURNAL_SLOT = Symbol.for("@cosmic-pi/pi-subagents/workflow-journal/v3");

interface JournalGlobalState {
  [JOURNAL_SLOT]?: JournalSlot;
}

const slot = (): JournalSlot => {
  // SAFETY: This process-owned symbol slot is the sole property this module adds to globalThis.
  // It survives extension reloads so a session can resume a run from before /reload.
  const state = globalThis as typeof globalThis & JournalGlobalState;
  const current = state[JOURNAL_SLOT];
  if (current?.version === 3 && current.sessions instanceof Map) return current;
  const created: JournalSlot = { version: 3, sessions: new Map() };
  state[JOURNAL_SLOT] = created;
  return created;
};

const touch = <K, V>(map: Map<K, V>, key: K, value: V): void => {
  map.delete(key);
  map.set(key, value);
};

const sessionJournals = (sessionKey: string): SessionJournals => {
  const sessions = slot().sessions;
  const existing = sessions.get(sessionKey) ?? new Map<string, RunJournal>();
  touch(sessions, sessionKey, existing);
  while (sessions.size > WORKFLOW_JOURNAL_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  return existing;
};

const journalChars = (journals: SessionJournals): number =>
  [...journals.values()].reduce(
    (sum, run) => sum + run.entries.reduce((total, entry) => total + entry.chars, 0),
    0,
  );

const newestClosed = (journals: SessionJournals): RunJournal | undefined =>
  [...journals.values()].reduce<RunJournal | undefined>(
    (newest, run) => (run.closedOrder > (newest?.closedOrder ?? 0) ? run : newest),
    undefined,
  );

const close = (journals: SessionJournals, run: RunJournal): void => {
  if (!run.open) return;
  run.open = false;
  run.closedOrder = (newestClosed(journals)?.closedOrder ?? 0) + 1;
};

/**
 * Drops the oldest closed runs past the bounds. A run still open is never dropped, and neither
 * is the newest closed one, which the main agent may resume right after its failure.
 */
const trim = (journals: SessionJournals): void => {
  const newest = newestClosed(journals);
  for (const [runId, run] of journals) {
    if (
      journals.size <= WORKFLOW_RETAINED_RUNS &&
      journalChars(journals) <= WORKFLOW_JOURNAL_MAX_CHARS
    )
      return;
    if (!run.open && run !== newest) journals.delete(runId);
  }
};

export const makeWorkflowReplay = (
  entries: ReadonlyArray<WorkflowJournalEntry>,
): WorkflowReplay => {
  const queues = new Map<string, WorkflowJournalEntry[]>();
  for (const entry of entries) queues.set(entry.key, [...(queues.get(entry.key) ?? []), entry]);
  return { take: (key) => queues.get(key)?.shift() };
};

/**
 * Session-scoped memory of agent() results, keyed by the Pi session that ran them. It outlives
 * reloads but not the Pi process; a run's files cover a restart.
 */
export class WorkflowJournal extends Context.Service<WorkflowJournal, WorkflowJournalContract>()(
  "pi-subagents/workflow/journal/WorkflowJournal",
) {
  static readonly layer = (sessionKey: string | undefined): Layer.Layer<WorkflowJournal> =>
    Layer.sync(this, () => {
      // Without a stable session id, journals still work within this activation.
      const local: SessionJournals = new Map();
      const journals = sessionKey ? () => sessionJournals(sessionKey) : () => local;
      const withRun = (runId: string, change: (run: RunJournal, runs: SessionJournals) => void) =>
        Effect.sync(() => {
          const runs = journals();
          const run = runs.get(runId);
          if (run) change(run, runs);
        });
      return WorkflowJournal.of({
        open: (runId, name, origin) =>
          Effect.sync(() => {
            const runs = journals();
            if (!runs.has(runId))
              runs.set(runId, {
                name,
                origin,
                entries: [],
                workspaces: new Set(),
                open: true,
                stopped: false,
                closedOrder: 0,
              });
            trim(runs);
          }),
        record: (runId, entry) =>
          withRun(runId, (run, runs) => {
            run.entries.push(entry);
            if (entry.workspaceId !== undefined) run.workspaces.add(entry.workspaceId);
            trim(runs);
          }),
        noteWorkspace: (runId, workspaceId) =>
          withRun(runId, (run) => void run.workspaces.add(workspaceId)),
        dropWorkspace: (runId, workspaceId) =>
          withRun(runId, (run) => void run.workspaces.delete(workspaceId)),
        noteStop: (runId) =>
          withRun(runId, (run) => {
            run.stopped = true;
          }),
        noteEnded: (runId, state) =>
          withRun(runId, (run) => {
            run.ended = state;
          }),
        finish: (runId) =>
          withRun(runId, (run, runs) => {
            close(runs, run);
            trim(runs);
          }),
        replay: (runId) =>
          Effect.sync(() => {
            const run = journals().get(runId);
            return run ? makeWorkflowReplay(run.entries) : undefined;
          }),
        has: (runId) => Effect.sync(() => journals().has(runId)),
        interruptedRuns: Effect.sync(() =>
          [...journals()].flatMap(([runId, run]): WorkflowInterruptedRun[] =>
            run.open
              ? [
                  {
                    runId,
                    name: run.name,
                    finished: run.entries.length,
                    workspaces: [...run.workspaces],
                    ...(run.stopped && { stopped: true }),
                    ...(run.ended !== undefined && { ended: run.ended }),
                    origin: run.origin,
                  },
                ]
              : [],
          ),
        ),
      });
    });
}
