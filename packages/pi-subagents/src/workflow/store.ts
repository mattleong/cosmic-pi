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
  pruneWorkflowRunDirectories,
  touchWorkflowRunDirectory,
  WORKFLOW_RUN_DIRECTORIES_KEPT,
  workflowRunsDirectory,
  type WorkflowRunFileError,
  type WorkflowRunFiles,
} from "../boundary/workflow-run-files.ts";
import {
  parseWorkflowScript,
  WORKFLOW_SCRIPT_MAX_CHARS,
  type WorkflowMeta,
  type WorkflowScript,
} from "./script.ts";

export const WORKFLOW_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const WORKFLOW_LIST_LIMIT = 64;
export const WORKFLOW_LIST_DIAGNOSTIC_LIMIT = 32;
/** UTF-8 bound matching the script character bound for ASCII scripts. */
const SCRIPT_MAX_BYTES = WORKFLOW_SCRIPT_MAX_CHARS * 4;

export type WorkflowScope = "project" | "user";

export class WorkflowSourceError extends Schema.TaggedError<WorkflowSourceError>()(
  "WorkflowSourceError",
  { message: Schema.String },
) {}

export interface LoadedWorkflow {
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

export interface WorkflowListing {
  readonly workflows: ReadonlyArray<SavedWorkflowSummary>;
  readonly diagnostics: ReadonlyArray<{ readonly path: string; readonly message: string }>;
  readonly truncated: boolean;
}

export interface WorkflowStoreContract {
  /** A saved workflow by name; the trusted project's copy wins over the user's. */
  readonly load: (name: string) => Effect.Effect<LoadedWorkflow, WorkflowSourceError>;
  /** A script file the agent wrote, absolute or relative to the session cwd. */
  readonly loadPath: (path: string) => Effect.Effect<LoadedWorkflow, WorkflowSourceError>;
  readonly list: Effect.Effect<WorkflowListing>;
  /**
   * Saves a starting run's script in its own private directory under the agent directory, after
   * pruning run directories that are neither among the newest nor written in the last day; runs
   * named in `live` are never pruned.
   */
  readonly createRunFiles: (
    runId: string,
    source: string,
    live: ReadonlySet<string>,
  ) => Effect.Effect<WorkflowRunFiles, WorkflowRunFileError>;
  /** Appends one line to a run's results journal, which also keeps its directory from pruning. */
  readonly appendRunJournal: (
    files: WorkflowRunFiles,
    line: string,
  ) => Effect.Effect<void, WorkflowRunFileError>;
  /** Marks a live run's directory as recent, so no Pi process prunes it; failures are ignored. */
  readonly touchRunFiles: (files: WorkflowRunFiles) => Effect.Effect<void>;
}

export interface WorkflowStoreOptions {
  readonly cwd: string;
  readonly agentDirectory: string;
  /** Read live: trust can change during a session. */
  readonly isProjectTrusted: () => boolean;
}

const sourceError = (message: string) => new WorkflowSourceError({ message });
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

        const roots = (): ReadonlyArray<{
          readonly scope: WorkflowScope;
          readonly directory: string;
        }> => [
          ...(options.isProjectTrusted()
            ? [
                {
                  scope: "project" as const,
                  directory: paths.join(options.cwd, ".pi", "workflows"),
                },
              ]
            : []),
          { scope: "user" as const, directory: paths.join(options.agentDirectory, "workflows") },
        ];

        const read = (path: string, root: string) =>
          safeFile.readContainedRegularFile(path, root, SCRIPT_MAX_BYTES).pipe(
            Effect.mapError(() => sourceError(`Couldn't read the workflow file ${path}.`)),
            Effect.flatMap(({ bytes }) =>
              Effect.try({
                try: () => decoder.decode(bytes),
                catch: () => sourceError(`The workflow file ${path} isn't valid UTF-8.`),
              }),
            ),
            Effect.flatMap((source) =>
              parseWorkflowScript(source).pipe(
                Effect.mapError((error) => sourceError(`${path}: ${error.message}`)),
              ),
            ),
          );

        const exists = (path: string) => fs.exists(path).pipe(Effect.orElseSucceed(() => false));

        const load = (name: string) =>
          Effect.gen(function* () {
            if (!WORKFLOW_NAME_PATTERN.test(name))
              return yield* sourceError(
                "Workflow names use lowercase letters, digits, `-` and `_`, starting with a letter or digit.",
              );
            for (const { scope, directory } of roots()) {
              const path = paths.join(directory, `${name}.js`);
              if (yield* exists(path))
                return {
                  name,
                  scope,
                  path,
                  script: yield* read(path, directory),
                } satisfies LoadedWorkflow;
            }
            return yield* sourceError(
              `No saved workflow named "${name}". Save it as .pi/workflows/${name}.js in a trusted project or in the agent directory's workflows folder.`,
            );
          });

        const loadPath = (path: string) =>
          Effect.gen(function* () {
            if (!path.endsWith(".js"))
              return yield* sourceError(`Workflow script files end in .js: ${path}`);
            const resolved = paths.resolve(options.cwd, path);
            const script = yield* read(resolved, paths.dirname(resolved));
            return { name: script.meta.name, path: resolved, script } satisfies LoadedWorkflow;
          });

        const listRoot = (scope: WorkflowScope, directory: string) =>
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
          const found = (yield* Effect.forEach(roots(), ({ scope, directory }) =>
            listRoot(scope, directory),
          )).flat();
          const seen = new Set<string>();
          const unique = found.filter((entry) => !seen.has(entry.name) && seen.add(entry.name));
          const workflows: SavedWorkflowSummary[] = [];
          const diagnostics: Array<{ path: string; message: string }> = [];
          for (const entry of unique.slice(0, WORKFLOW_LIST_LIMIT)) {
            const path = paths.join(entry.directory, `${entry.name}.js`);
            const loaded = yield* Effect.result(read(path, entry.directory));
            if (loaded._tag === "Success")
              workflows.push({
                name: entry.name,
                scope: entry.scope,
                path,
                meta: loaded.success.meta,
              });
            else if (diagnostics.length < WORKFLOW_LIST_DIAGNOSTIC_LIMIT)
              diagnostics.push({ path, message: loaded.failure.message });
          }
          return { workflows, diagnostics, truncated: unique.length > WORKFLOW_LIST_LIMIT };
        });

        const runsRoot = workflowRunsDirectory(paths, options.agentDirectory);
        const platform = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
          effect.pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, paths),
          );

        const createRunFiles = (runId: string, source: string, live: ReadonlySet<string>) =>
          platform(
            // The new run's directory makes up the number kept.
            pruneWorkflowRunDirectories(runsRoot, WORKFLOW_RUN_DIRECTORIES_KEPT - 1, live).pipe(
              Effect.andThen(createWorkflowRunFiles(runsRoot, runId, source)),
            ),
          );

        const appendRunJournal = (files: WorkflowRunFiles, line: string) =>
          platform(appendWorkflowRunJournal(files, line));

        const touchRunFiles = (files: WorkflowRunFiles) =>
          platform(touchWorkflowRunDirectory(files));

        return WorkflowStore.of({
          load,
          loadPath,
          list,
          createRunFiles,
          appendRunJournal,
          touchRunFiles,
        });
      }),
    );
}
