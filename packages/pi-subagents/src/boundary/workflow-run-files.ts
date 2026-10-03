import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** Run directories kept under the agent directory; older ones are pruned when a run starts. */
export const WORKFLOW_RUN_DIRECTORIES_KEPT = 64;
/**
 * A run directory written this recently is never pruned, however many newer ones exist: every Pi
 * process shares the directory, and another one may still be running it.
 */
export const WORKFLOW_RUN_DIRECTORY_GRACE_MS = 24 * 60 * 60 * 1000;
/** Only directories named like run ids are ever pruned. */
const RUN_DIRECTORY = /^wf-[a-z0-9]+-[1-9][0-9]*$/u;
const SCRIPT_FILE = "script.js";
const JOURNAL_FILE = "journal.jsonl";

export class WorkflowRunFileError extends Schema.TaggedError<WorkflowRunFileError>()(
  "WorkflowRunFileError",
  { message: Schema.String },
) {}

/** A run's private directory: the script copy the main agent edits and its results journal. */
export interface WorkflowRunFiles {
  readonly directory: string;
  readonly script: string;
  /** Created by the first appended line. */
  readonly journal: string;
}

/** Where runs keep their files: `<agent-dir>/subagents/workflow-runs`. */
export const workflowRunsDirectory = (paths: Path.Path, agentDirectory: string): string =>
  paths.join(agentDirectory, "subagents", "workflow-runs");

const runFileError = (action: string) => (error: { readonly message: string }) =>
  new WorkflowRunFileError({ message: `Couldn't ${action}: ${error.message}` });

const modifiedAt = (info: FileSystem.File.Info): number =>
  Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() });

/**
 * When a run directory was last written. Creating it and saving its script set its time, and
 * every journal append refreshes it, so a live run in any process keeps it recent.
 */
const lastWritten = (fs: FileSystem.FileSystem, directory: string) =>
  fs.stat(directory).pipe(
    Effect.map((info) => (info.type === "Directory" ? modifiedAt(info) : undefined)),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * Removes the run directories outside the `keep` most recently written that weren't written in
 * the last {@link WORKFLOW_RUN_DIRECTORY_GRACE_MS}, never one named in `live`. Pruning is best
 * effort: an entry that can't be read or removed stays.
 */
export const pruneWorkflowRunDirectories = (
  root: string,
  keep: number,
  live: ReadonlySet<string>,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const names = (yield* fs.readDirectory(root)).filter((name) => RUN_DIRECTORY.test(name));
    const dated = yield* Effect.forEach(names, (name) =>
      lastWritten(fs, paths.join(root, name)).pipe(
        Effect.map((at) => (at === undefined ? [] : [{ name, at }])),
      ),
    );
    const cutoff = (yield* Clock.currentTimeMillis) - WORKFLOW_RUN_DIRECTORY_GRACE_MS;
    const stale = dated
      .flat()
      .sort((left, right) => right.at - left.at || right.name.localeCompare(left.name))
      .slice(Math.max(0, keep))
      .filter((entry) => entry.at < cutoff && !live.has(entry.name));
    yield* Effect.forEach(
      stale,
      (entry) => Effect.ignore(fs.remove(paths.join(root, entry.name), { recursive: true })),
      { discard: true },
    );
  }).pipe(Effect.ignore);

/**
 * Creates a run's private directory (0700) and its script copy (0600). An existing directory or
 * file is never overwritten.
 */
export const createWorkflowRunFiles = (
  root: string,
  runId: string,
  source: string,
): Effect.Effect<WorkflowRunFiles, WorkflowRunFileError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    if (!RUN_DIRECTORY.test(runId))
      return yield* new WorkflowRunFileError({ message: `${runId} isn't a workflow run id.` });
    const directory = paths.join(root, runId);
    const script = paths.join(directory, SCRIPT_FILE);
    yield* fs
      .makeDirectory(root, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(runFileError("create the workflow runs directory")));
    // Not recursive: an existing directory fails instead of being reused.
    yield* fs
      .makeDirectory(directory, { mode: 0o700 })
      .pipe(
        Effect.andThen(fs.chmod(directory, 0o700)),
        Effect.mapError(runFileError("create the run directory")),
      );
    yield* fs
      .writeFileString(script, source, { flag: "wx", mode: 0o600 })
      .pipe(
        Effect.andThen(fs.chmod(script, 0o600)),
        Effect.mapError(runFileError("save the script")),
      );
    return { directory, script, journal: paths.join(directory, JOURNAL_FILE) };
  });

/** Marks a run's directory as just written, so no Pi process prunes it while the run lives. */
export const touchWorkflowRunDirectory = (
  files: WorkflowRunFiles,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Node reads numeric times as seconds since the epoch.
    const now = (yield* Clock.currentTimeMillis) / 1_000;
    yield* Effect.ignore(fs.utimes(files.directory, now, now));
  });

/**
 * Appends one line to a run's results journal, creating it private (0600) if needed, and marks
 * the run's directory as just written so no Pi process prunes it while the run works.
 */
export const appendWorkflowRunJournal = (
  files: WorkflowRunFiles,
  line: string,
): Effect.Effect<void, WorkflowRunFileError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs
      .writeFileString(files.journal, `${line}\n`, { flag: "a", mode: 0o600 })
      .pipe(
        Effect.andThen(fs.chmod(files.journal, 0o600)),
        Effect.mapError(runFileError("write the results journal")),
      );
    // The line is written; a directory that can't be marked only ages sooner.
    yield* touchWorkflowRunDirectory(files);
  });
