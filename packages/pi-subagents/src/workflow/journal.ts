import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import { WORKFLOW_RETAINED_RUNS, type WorkflowEndedState, type WorkflowSource } from "./model.ts";

const WORKFLOW_JOURNAL_SESSIONS = 16;
export const WORKFLOW_JOURNAL_MAX_CHARS = 16 * 1024 * 1024;

export interface WorkflowJournalEntry {
  readonly key: string;
  readonly result: Schema.Json;
  readonly outputTokens: number;
  readonly chars: number;
  readonly workspaceId?: string | undefined;
  readonly label?: string | undefined;
  readonly runId?: string | undefined;
}

export interface WorkflowReplay {
  readonly take: (key: string) => WorkflowJournalEntry | undefined;
}

interface WorkflowRunOrigin {
  readonly source: WorkflowSource;
  readonly scriptPath?: string | undefined;
}

export interface WorkflowInterruptedRun {
  readonly runId: string;
  readonly name: string;
  readonly finished: number;
  readonly workspaces: ReadonlyArray<string>;
  readonly stopped?: boolean | undefined;
  readonly ended?: WorkflowEndedState | undefined;
  readonly origin: WorkflowRunOrigin;
  readonly restarted?: boolean | undefined;
}

export interface WorkflowJournalContract {
  readonly open: (runId: string, name: string, origin: WorkflowRunOrigin) => Effect.Effect<void>;
  readonly record: (runId: string, entry: WorkflowJournalEntry) => Effect.Effect<void>;
  readonly noteWorkspace: (runId: string, workspaceId: string) => Effect.Effect<void>;
  readonly dropWorkspace: (runId: string, workspaceId: string) => Effect.Effect<void>;
  readonly noteStop: (runId: string) => Effect.Effect<void>;
  readonly noteEnded: (runId: string, state: WorkflowEndedState) => Effect.Effect<void>;
  readonly finish: (runId: string) => Effect.Effect<void>;
  readonly replay: (runId: string) => Effect.Effect<WorkflowReplay | undefined>;
  readonly has: (runId: string) => Effect.Effect<boolean>;
  readonly interruptedRuns: Effect.Effect<ReadonlyArray<WorkflowInterruptedRun>>;
}

interface RunJournal {
  readonly name: string;
  readonly origin: WorkflowRunOrigin;
  readonly entries: WorkflowJournalEntry[];
  readonly workspaces: Set<string>;
  open: boolean;
  stopped: boolean;
  ended?: WorkflowEndedState | undefined;
  closedOrder: number;
}

type SessionJournals = Map<string, RunJournal>;

interface JournalSlot {
  readonly version: 3;
  readonly sessions: Map<string, SessionJournals>;
}

const JOURNAL_SLOT = Symbol.for("@cosmic-pi/pi-subagents/workflow-journal/v3");

const isJournalSlot = <Value>(value: Value): value is Value & JournalSlot =>
  Predicate.hasProperty(value, "version") &&
  value.version === 3 &&
  Predicate.hasProperty(value, "sessions") &&
  Predicate.isMap(value.sessions);

const slot = (): JournalSlot => {
  const current: unknown = Object.getOwnPropertyDescriptor(globalThis, JOURNAL_SLOT)?.value;
  if (isJournalSlot(current)) return current;
  const created: JournalSlot = { version: 3, sessions: new Map() };
  Object.defineProperty(globalThis, JOURNAL_SLOT, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: created,
  });
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

export class WorkflowJournal extends Context.Service<WorkflowJournal, WorkflowJournalContract>()(
  "pi-subagents/workflow/journal/WorkflowJournal",
) {
  static readonly layer = (sessionKey: string | undefined): Layer.Layer<WorkflowJournal> =>
    Layer.sync(this, () => {
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
