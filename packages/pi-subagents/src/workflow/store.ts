import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { SafeFile } from "pi-cosmic-core";
import {
  appendWorkflowRunJournal,
  createWorkflowRunFiles,
  listWorkflowRunDirectories,
  pruneWorkflowRunDirectories,
  readWorkflowRunJournal,
  touchWorkflowRunDirectory,
  WORKFLOW_RUN_DIRECTORIES_KEPT,
  WorkflowRunFileError,
  workflowRunFilesOf,
  workflowRunResultPath,
  workflowRunsDirectory,
  workflowRunWrittenAt,
  writeWorkflowRunRecord,
  writeWorkflowRunResult,
  type WorkflowRunFiles,
} from "../boundary/workflow-run-files.ts";
import { WORKFLOW_RUN_RECORD_MAX_BYTES } from "./run-record.ts";
import {
  parseWorkflowScript,
  WORKFLOW_SCRIPT_MAX_CHARS,
  WorkflowScriptError,
  type WorkflowMeta,
  type WorkflowScript,
} from "./script.ts";

const WORKFLOW_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WORKFLOW_LIST_LIMIT = 64;
const WORKFLOW_LIST_DIAGNOSTIC_LIMIT = 32;
const SCRIPT_MAX_BYTES = WORKFLOW_SCRIPT_MAX_CHARS * 4;

type WorkflowScope = "project" | "user";

const WORKFLOW_SOURCE_PROBLEMS = [
  "unreadable",
  "not-utf8",
  "script",
  "not-found",
  "bad-name",
  "not-js",
  "bad-reference",
] as const;

export class WorkflowSourceError extends Schema.TaggedError<WorkflowSourceError>()(
  "WorkflowSourceError",
  {
    message: Schema.String,
    problem: Schema.Literals(WORKFLOW_SOURCE_PROBLEMS),
    subject: Schema.String,
    script: Schema.optional(WorkflowScriptError),
  },
) {}

interface LoadedWorkflow {
  readonly name: string;
  readonly scope?: WorkflowScope;
  readonly path: string;
  readonly script: WorkflowScript;
}

export interface SavedWorkflowSummary {
  readonly name: string;
  readonly scope: WorkflowScope;
  readonly path: string;
  readonly meta: WorkflowMeta;
}

export interface WorkflowLocations {
  readonly project: string;
  readonly projectTrusted: boolean;
  readonly user: string;
}

export interface WorkflowListing {
  readonly workflows: ReadonlyArray<SavedWorkflowSummary>;
  readonly diagnostics: ReadonlyArray<{ readonly path: string; readonly message: string }>;
  readonly truncated: boolean;
  readonly locations: WorkflowLocations;
}

export const savedWorkflowFiles = (locations: WorkflowLocations, name = "<name>"): string => {
  const user = `${locations.user}/${name}.js`;
  return locations.projectTrusted
    ? `${locations.project}/${name}.js or ${user}`
    : `${user} (${locations.project} is used only in trusted projects)`;
};

export interface WorkflowRunRecordFile {
  readonly runId: string;
  readonly files: WorkflowRunFiles;
  readonly text: string;
  readonly writtenAt: number | undefined;
}

export interface WorkflowStoreContract {
  readonly load: (name: string) => Effect.Effect<LoadedWorkflow, WorkflowSourceError>;
  readonly loadPath: (path: string) => Effect.Effect<LoadedWorkflow, WorkflowSourceError>;
  readonly list: Effect.Effect<WorkflowListing>;
  readonly locations: Effect.Effect<WorkflowLocations>;
  readonly createRunFiles: (
    runId: string,
    source: string,
    live: ReadonlySet<string>,
  ) => Effect.Effect<WorkflowRunFiles, WorkflowRunFileError>;
  readonly appendRunJournal: (
    files: WorkflowRunFiles,
    line: string,
  ) => Effect.Effect<void, WorkflowRunFileError>;
  readonly touchRunFiles: (files: WorkflowRunFiles) => Effect.Effect<void>;
  readonly writeRunRecord: (
    files: WorkflowRunFiles,
    text: string,
  ) => Effect.Effect<void, WorkflowRunFileError>;
  readonly readRunRecord: (
    runId: string,
  ) => Effect.Effect<WorkflowRunRecordFile | undefined, WorkflowRunFileError>;
  readonly hasRunFiles: (runId: string) => Effect.Effect<boolean>;
  readonly listRunRecords: (
    limit: number,
    keep: (file: WorkflowRunRecordFile) => boolean,
  ) => Effect.Effect<ReadonlyArray<WorkflowRunRecordFile>>;
  readonly writeRunResult: (
    files: WorkflowRunFiles,
    ordinal: number,
    text: string,
  ) => Effect.Effect<string, WorkflowRunFileError>;
  readonly readRunResult: (
    files: WorkflowRunFiles,
    name: string,
    maximumChars: number,
  ) => Effect.Effect<string | undefined>;
  readonly readRunJournal: (
    files: WorkflowRunFiles,
    maximumChars: number,
  ) => Effect.Effect<ReadonlyArray<string>, WorkflowRunFileError>;
}

interface WorkflowStoreOptions {
  readonly cwd: string;
  readonly agentDirectory: string;
  readonly isProjectTrusted: () => boolean;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

export class WorkflowStore extends Context.Service<WorkflowStore, WorkflowStoreContract>()(
  "pi-subagents/workflow/store/WorkflowStore",
) {
  static readonly layer = (
    options: WorkflowStoreOptions,
  ): Layer.Layer<WorkflowStore, never, FileSystem.FileSystem | Path.Path | SafeFile> =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const safeFile = yield* SafeFile;
        const platform = Effect.provideContext(
          Context.make(FileSystem.FileSystem, fs).pipe(Context.add(Path.Path, paths)),
        );

        const currentLocations = (): WorkflowLocations => ({
          project: paths.join(options.cwd, ".pi", "workflows"),
          projectTrusted: options.isProjectTrusted(),
          user: paths.join(options.agentDirectory, "workflows"),
        });

        const roots = (locations: WorkflowLocations) => [
          ...(locations.projectTrusted
            ? [{ scope: "project" as const, directory: locations.project }]
            : []),
          { scope: "user" as const, directory: locations.user },
        ];

        const readContained = (path: string, root: string, maximumBytes: number) =>
          fs
            .realPath(root)
            .pipe(
              Effect.flatMap((canonical) =>
                safeFile.readContainedRegularFile(path, canonical, maximumBytes),
              ),
            );

        const read = (path: string, root: string) => {
          const subject = paths.basename(path);
          return readContained(path, root, SCRIPT_MAX_BYTES).pipe(
            Effect.mapError(
              () =>
                new WorkflowSourceError({
                  message: `Couldn't read the workflow file ${path}.`,
                  problem: "unreadable",
                  subject,
                }),
            ),
            Effect.flatMap(({ bytes }) =>
              Effect.try({
                try: () => decoder.decode(bytes),
                catch: () =>
                  new WorkflowSourceError({
                    message: `The workflow file ${path} isn't valid UTF-8.`,
                    problem: "not-utf8",
                    subject,
                  }),
              }),
            ),
            Effect.flatMap((source) =>
              parseWorkflowScript(source).pipe(
                Effect.mapError(
                  (script) =>
                    new WorkflowSourceError({
                      message: `${path}: ${script.message}`,
                      problem: "script",
                      subject,
                      script,
                    }),
                ),
              ),
            ),
          );
        };

        const exists = (path: string) => fs.exists(path).pipe(Effect.orElseSucceed(() => false));

        const load = (name: string) =>
          Effect.gen(function* () {
            if (!WORKFLOW_NAME_PATTERN.test(name))
              return yield* new WorkflowSourceError({
                message:
                  "Workflow names use lowercase letters, digits, `-` and `_`, starting with a letter or digit.",
                problem: "bad-name",
                subject: name,
              });
            const locations = currentLocations();
            for (const { scope, directory } of roots(locations)) {
              const path = paths.join(directory, `${name}.js`);
              if (yield* exists(path))
                return {
                  name,
                  scope,
                  path,
                  script: yield* read(path, directory),
                } satisfies LoadedWorkflow;
            }
            return yield* new WorkflowSourceError({
              message: `No saved workflow named "${name}". Save it as ${savedWorkflowFiles(locations, name)}.`,
              problem: "not-found",
              subject: name,
            });
          });

        const loadPath = (path: string) =>
          Effect.gen(function* () {
            if (!path.endsWith(".js"))
              return yield* new WorkflowSourceError({
                message: `Workflow script files end in .js: ${path}`,
                problem: "not-js",
                subject: paths.basename(path),
              });
            const resolved = paths.resolve(options.cwd, path);
            const script = yield* read(resolved, paths.dirname(resolved));
            return { name: script.meta.name, path: resolved, script } satisfies LoadedWorkflow;
          });

        const listRoot = ({ scope, directory }: { scope: WorkflowScope; directory: string }) =>
          fs.readDirectory(directory).pipe(
            Effect.orElseSucceed((): ReadonlyArray<string> => []),
            Effect.map((entries) =>
              entries
                .filter(
                  (entry) =>
                    entry.endsWith(".js") && WORKFLOW_NAME_PATTERN.test(entry.slice(0, -3)),
                )
                .sort()
                .map((entry) => ({ scope, directory, name: entry.slice(0, -3) })),
            ),
          );

        const list = Effect.gen(function* () {
          const locations = currentLocations();
          const found = (yield* Effect.forEach(roots(locations), (root) => listRoot(root))).flat();
          const seen = new Set<string>();
          const unique = found.filter((entry) => !seen.has(entry.name) && seen.add(entry.name));
          const [workflows, diagnostics] = yield* Effect.partition(
            unique.slice(0, WORKFLOW_LIST_LIMIT),
            ({ scope, directory, name }) => {
              const path = paths.join(directory, `${name}.js`);
              return read(path, directory).pipe(
                Effect.map(({ meta }): SavedWorkflowSummary => ({ name, scope, path, meta })),
                Effect.mapError(({ message }) => ({ path, message })),
              );
            },
          );
          return {
            workflows,
            diagnostics: diagnostics.slice(0, WORKFLOW_LIST_DIAGNOSTIC_LIMIT),
            truncated: unique.length > WORKFLOW_LIST_LIMIT,
            locations,
          };
        });

        const runsRoot = workflowRunsDirectory(paths, options.agentDirectory);

        const createRunFiles = (runId: string, source: string, live: ReadonlySet<string>) =>
          platform(
            pruneWorkflowRunDirectories(runsRoot, WORKFLOW_RUN_DIRECTORIES_KEPT - 1, live).pipe(
              Effect.andThen(createWorkflowRunFiles(runsRoot, runId, source)),
            ),
          );

        const readRunText = (path: string, files: WorkflowRunFiles, maximumBytes: number) =>
          readContained(path, files.directory, maximumBytes).pipe(
            Effect.flatMap(({ bytes }) => Effect.try(() => decoder.decode(bytes))),
            Effect.mapError(() => new WorkflowRunFileError({ message: `Couldn't read ${path}.` })),
          );

        const readRunRecord = (runId: string) =>
          Effect.gen(function* () {
            const files = workflowRunFilesOf(paths, runsRoot, runId);
            if (!files || !(yield* exists(files.record))) return undefined;
            const text = yield* readRunText(files.record, files, WORKFLOW_RUN_RECORD_MAX_BYTES);
            const writtenAt = yield* platform(workflowRunWrittenAt(files));
            return { runId, files, text, writtenAt } satisfies WorkflowRunRecordFile;
          });

        const hasRunFiles = (runId: string) => {
          const files = workflowRunFilesOf(paths, runsRoot, runId);
          return files ? exists(files.directory) : Effect.succeed(false);
        };

        const listRunRecords = (limit: number, keep: (file: WorkflowRunRecordFile) => boolean) =>
          Effect.gen(function* () {
            const kept: WorkflowRunRecordFile[] = [];
            for (const runId of yield* platform(listWorkflowRunDirectories(runsRoot))) {
              if (kept.length >= limit) break;
              const file = yield* readRunRecord(runId).pipe(Effect.orElseSucceed(() => undefined));
              if (file && keep(file)) kept.push(file);
            }
            return kept;
          });

        const readRunResult = (files: WorkflowRunFiles, name: string, maximumChars: number) => {
          const path = workflowRunResultPath(paths, files, name);
          return path === undefined
            ? Effect.undefined
            : readRunText(path, files, maximumChars).pipe(Effect.orElseSucceed(() => undefined));
        };

        return WorkflowStore.of({
          load,
          loadPath,
          list,
          locations: Effect.sync(currentLocations),
          createRunFiles,
          appendRunJournal: (files, line) => platform(appendWorkflowRunJournal(files, line)),
          touchRunFiles: (files) => platform(touchWorkflowRunDirectory(files)),
          writeRunRecord: (files, text) => platform(writeWorkflowRunRecord(files, text)),
          readRunRecord,
          hasRunFiles,
          listRunRecords,
          writeRunResult: (files, ordinal, text) =>
            platform(writeWorkflowRunResult(files, ordinal, text)),
          readRunResult,
          readRunJournal: (files, maximumChars) =>
            platform(readWorkflowRunJournal(files, maximumChars)),
        });
      }),
    );
}
