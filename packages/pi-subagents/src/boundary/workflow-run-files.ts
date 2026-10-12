import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export const WORKFLOW_RUN_DIRECTORIES_KEPT = 64;
const WORKFLOW_RUN_DIRECTORY_GRACE_MS = 24 * 60 * 60 * 1000;
const RUN_DIRECTORY = /^wf-[a-z0-9]+-[1-9][0-9]*$/u;
const SCRIPT_FILE = "script.js";
const JOURNAL_FILE = "journal.jsonl";
const RECORD_FILE = "run.json";
const RESULTS_DIRECTORY = "results";
const RESULT_FILE = /^results\/[1-9][0-9]*\.json$/u;

export class WorkflowRunFileError extends Schema.TaggedError<WorkflowRunFileError>()(
  "WorkflowRunFileError",
  { message: Schema.String },
) {}

export interface WorkflowRunFiles {
  readonly directory: string;
  readonly script: string;
  readonly journal: string;
  readonly record: string;
}

export const workflowRunsDirectory = (paths: Path.Path, agentDirectory: string): string =>
  paths.join(agentDirectory, "subagents", "workflow-runs");

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

const lastWritten = (fs: FileSystem.FileSystem, directory: string) =>
  fs.stat(directory).pipe(
    Effect.map((info) => (info.type === "Directory" ? modifiedAt(info) : undefined)),
    Effect.orElseSucceed(() => undefined),
  );

export const workflowRunWrittenAt = (
  files: WorkflowRunFiles,
): Effect.Effect<number | undefined, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => lastWritten(fs, files.directory)));

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
      .toSorted((left, right) => right.at - left.at || right.name.localeCompare(left.name));
  });

export const listWorkflowRunDirectories = (
  root: string,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
  newestRunDirectories(root).pipe(
    Effect.map((entries) => entries.map((entry) => entry.name)),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

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

export const touchWorkflowRunDirectory = (
  files: WorkflowRunFiles,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const now = (yield* Clock.currentTimeMillis) / 1_000;
    yield* Effect.ignore(fs.utimes(files.directory, now, now));
  });

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
    yield* touchWorkflowRunDirectory(files);
  });

export const writeWorkflowRunRecord = (
  files: WorkflowRunFiles,
  text: string,
): Effect.Effect<void, WorkflowRunFileError, FileSystem.FileSystem | Path.Path> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const temporary = yield* Effect.acquireRelease(
        fs.makeTempFile({ directory: files.directory, prefix: ".run-record-" }),
        (path) => Effect.ignore(fs.remove(paths.dirname(path), { recursive: true })),
      );
      yield* fs.writeFileString(temporary, `${text}\n`, { mode: 0o600 });
      yield* fs.chmod(temporary, 0o600);
      yield* fs.rename(temporary, files.record).pipe(Effect.uninterruptible);
    }),
  ).pipe(Effect.mapError(runFileError("save the run record")));

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

export const workflowRunResultPath = (
  paths: Path.Path,
  files: WorkflowRunFiles,
  name: string,
): string | undefined =>
  RESULT_FILE.test(name) ? paths.join(files.directory, ...name.split("/")) : undefined;

export const readWorkflowRunJournal = (
  files: WorkflowRunFiles,
  maximumBytes: number,
): Effect.Effect<ReadonlyArray<string>, WorkflowRunFileError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    if (!(yield* fs.exists(files.journal))) return [];
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
    return text.split("\n").slice(0, -1);
  }).pipe(Effect.mapError(runFileError("read the results journal")));
