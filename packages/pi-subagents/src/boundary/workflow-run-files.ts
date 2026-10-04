import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

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
const RECORD_FILE = "run.json";
const RESULTS_DIRECTORY = "results";
/** The only names a journal line may give a result file. */
const RESULT_FILE = /^results\/[1-9][0-9]*\.json$/u;

export class WorkflowRunFileError extends Schema.TaggedError<WorkflowRunFileError>()(
  "WorkflowRunFileError",
  { message: Schema.String },
) {}

/**
 * A run's private directory: the script copy the main agent edits, its results journal, and its
 * record of who runs it and how it ended.
 */
export interface WorkflowRunFiles {
  readonly directory: string;
  readonly script: string;
  /** Created by the first appended line. */
  readonly journal: string;
  /** `run.json`, written once the run starts in a session with a stable id. */
  readonly record: string;
}

/** Where runs keep their files: `<agent-dir>/subagents/workflow-runs`. */
export const workflowRunsDirectory = (paths: Path.Path, agentDirectory: string): string =>
  paths.join(agentDirectory, "subagents", "workflow-runs");

/** A run's files under `root`, or undefined when `runId` isn't a run id. */
export const workflowRunFilesOf = (
  paths: Path.Path,
  root: string,
  runId: string,
): WorkflowRunFiles | undefined => {
  if (!RUN_DIRECTORY.test(runId)) return undefined;
  const directory = paths.join(root, runId);
  return {
    directory,
    script: paths.join(directory, SCRIPT_FILE),
    journal: paths.join(directory, JOURNAL_FILE),
    record: paths.join(directory, RECORD_FILE),
  };
};

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
 * When a run's directory was last written, which a live run's regular refresh keeps recent, so
 * it serves as the run's heartbeat; undefined when it can't be read.
 */
export const workflowRunWrittenAt = (
  files: WorkflowRunFiles,
): Effect.Effect<number | undefined, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => lastWritten(fs, files.directory)));

/** Run directories under `root`, most recently written first; unreadable entries are left out. */
const newestRunDirectories = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const names = (yield* fs.readDirectory(root)).filter((name) => RUN_DIRECTORY.test(name));
    const dated = yield* Effect.forEach(names, (name) =>
      lastWritten(fs, paths.join(root, name)).pipe(
        Effect.map((at) => (at === undefined ? [] : [{ name, at }])),
      ),
    );
    return dated
      .flat()
      .sort((left, right) => right.at - left.at || right.name.localeCompare(left.name));
  });

/** The ids of the run directories, most recently written first; none when unreadable. */
export const listWorkflowRunDirectories = (
  root: string,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
  newestRunDirectories(root).pipe(
    Effect.map((entries) => entries.map((entry) => entry.name)),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
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
    const cutoff = (yield* Clock.currentTimeMillis) - WORKFLOW_RUN_DIRECTORY_GRACE_MS;
    const stale = (yield* newestRunDirectories(root))
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
    const files = workflowRunFilesOf(paths, root, runId);
    if (!files)
      return yield* new WorkflowRunFileError({ message: `${runId} isn't a workflow run id.` });
    const { directory, script } = files;
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
    return files;
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

/**
 * Replaces a run's `run.json` atomically: the text goes to a private temporary file in the run's
 * directory, which is then renamed over the record, so a reader never sees a partial record.
 */
export const writeWorkflowRunRecord = (
  files: WorkflowRunFiles,
  text: string,
): Effect.Effect<void, WorkflowRunFileError, FileSystem.FileSystem | Path.Path> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      // The temporary file sits in a directory of its own, removed once the record is replaced.
      const temporary = yield* Effect.acquireRelease(
        fs.makeTempFile({ directory: files.directory, prefix: ".run-record-" }),
        (path) => Effect.ignore(fs.remove(paths.dirname(path), { recursive: true })),
      );
      yield* fs.writeFileString(temporary, `${text}\n`, { mode: 0o600 });
      yield* fs.chmod(temporary, 0o600);
      yield* fs.rename(temporary, files.record).pipe(Effect.uninterruptible);
    }),
  ).pipe(Effect.mapError(runFileError("save the run record")));

/**
 * Saves the full value of result `ordinal` (0600) beside the run's journal and returns the name a
 * journal line gives it, relative to the run's directory.
 */
export const writeWorkflowRunResult = (
  files: WorkflowRunFiles,
  ordinal: number,
  text: string,
): Effect.Effect<string, WorkflowRunFileError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const name = `${RESULTS_DIRECTORY}/${ordinal}.json`;
    if (!RESULT_FILE.test(name))
      return yield* new WorkflowRunFileError({ message: `${ordinal} isn't a result number.` });
    const directory = paths.join(files.directory, RESULTS_DIRECTORY);
    const path = paths.join(files.directory, ...name.split("/"));
    yield* fs
      .makeDirectory(directory, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.andThen(fs.writeFileString(path, text, { mode: 0o600 })),
        Effect.andThen(fs.chmod(path, 0o600)),
        Effect.mapError(runFileError("save a full result")),
      );
    return name;
  });

/** Where a journal line's result file is, or undefined for a name no run writes. */
export const workflowRunResultPath = (
  paths: Path.Path,
  files: WorkflowRunFiles,
  name: string,
): string | undefined =>
  RESULT_FILE.test(name) ? paths.join(files.directory, ...name.split("/")) : undefined;

/**
 * The complete lines among the first `maximumBytes` of a run's results journal; none when it
 * doesn't exist yet. A line cut off by the bound, or by a write still under way, is left out.
 */
export const readWorkflowRunJournal = (
  files: WorkflowRunFiles,
  maximumBytes: number,
): Effect.Effect<ReadonlyArray<string>, WorkflowRunFileError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    if (!(yield* fs.exists(files.journal))) return [];
    // Run files are untrusted: the journal must be a regular file in its run's directory, not a
    // link to a file anywhere else.
    const [journal, directory] = yield* Effect.all([
      fs.realPath(files.journal),
      fs.realPath(files.directory),
    ]);
    if (
      journal !== paths.join(directory, JOURNAL_FILE) ||
      (yield* fs.stat(journal)).type !== "File"
    )
      return yield* new WorkflowRunFileError({
        message: "The results journal isn't a regular file in its run directory.",
      });
    const chunks = yield* fs
      .stream(journal, { bytesToRead: Math.max(0, maximumBytes) })
      .pipe(Stream.runCollect);
    const decoder = new TextDecoder();
    const text =
      chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
    // Every complete line ends in a newline, so whatever follows the last one is partial.
    return text.split("\n").slice(0, -1);
  }).pipe(Effect.mapError(runFileError("read the results journal")));
