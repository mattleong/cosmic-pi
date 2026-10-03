import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import { nodeFilePlatformLayer, SafeFile } from "pi-cosmic-core";
import { WorkflowStore } from "../../src/workflow/store.ts";

const script = (name: string) =>
  `export const meta = { name: ${JSON.stringify(name)}, description: "d" };\nreturn 1;\n`;

interface Fixture {
  readonly root: string;
  readonly cwd: string;
  readonly agentDirectory: string;
  readonly projectWorkflows: string;
  readonly userWorkflows: string;
  readonly trust: { value: boolean };
  readonly join: (...segments: ReadonlyArray<string>) => string;
  readonly write: (
    path: string,
    content: string,
  ) => Effect.Effect<void, PlatformError.PlatformError>;
}

const fixture: Effect.Effect<
  Fixture,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const root = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "pi-workflow-store-" }),
  );
  const cwd = paths.join(root, "project");
  const agentDirectory = paths.join(root, "agent");
  const projectWorkflows = paths.join(cwd, ".pi", "workflows");
  const userWorkflows = paths.join(agentDirectory, "workflows");
  yield* fs.makeDirectory(projectWorkflows, { recursive: true });
  yield* fs.makeDirectory(userWorkflows, { recursive: true });
  return {
    root,
    cwd,
    agentDirectory,
    projectWorkflows,
    userWorkflows,
    trust: { value: true },
    join: (...segments: ReadonlyArray<string>) => paths.join(...segments),
    write: (path: string, content: string) => fs.writeFileString(path, content),
  } satisfies Fixture;
});

const withStore = <A, E>(
  setup: Fixture,
  use: (store: WorkflowStore["Service"]) => Effect.Effect<A, E>,
) =>
  WorkflowStore.use(use).pipe(
    Effect.provide(
      WorkflowStore.layer({
        cwd: setup.cwd,
        agentDirectory: setup.agentDirectory,
        isProjectTrusted: () => setup.trust.value,
      }).pipe(
        Layer.provide(
          Layer.merge(
            SafeFile.layer.pipe(Layer.provide(nodeFilePlatformLayer)),
            nodeFilePlatformLayer,
          ),
        ),
      ),
    ),
  );

const failureMessage = <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.message));

describe("saved workflows", () => {
  it.effect("prefers the trusted project's copy and falls back to the user's", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* setup.write(setup.join(setup.projectWorkflows, "review.js"), script("project-review"));
      yield* setup.write(setup.join(setup.userWorkflows, "review.js"), script("user-review"));
      const trusted = yield* withStore(setup, (store) => store.load("review"));
      expect(trusted.script.meta.name).toBe("project-review");
      setup.trust.value = false;
      const untrusted = yield* withStore(setup, (store) => store.load("review"));
      expect([untrusted.scope, untrusted.script.meta.name]).toEqual(["user", "user-review"]);
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );

  it.effect("rejects unsafe names, missing workflows and invalid scripts", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* setup.write(setup.join(setup.userWorkflows, "broken.js"), "export const meta = 1;");
      expect(yield* failureMessage(withStore(setup, (store) => store.load("../escape")))).toMatch(
        /Workflow names/,
      );
      expect(yield* failureMessage(withStore(setup, (store) => store.load("missing")))).toMatch(
        /No saved workflow/,
      );
      expect(yield* failureMessage(withStore(setup, (store) => store.load("broken")))).toMatch(
        /broken\.js/,
      );
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );

  it.effect("does not follow symlinked workflow files", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      yield* setup.write(setup.join(setup.root, "outside.js"), script("outside"));
      yield* fs.symlink(
        setup.join(setup.root, "outside.js"),
        setup.join(setup.userWorkflows, "linked.js"),
      );
      expect(yield* failureMessage(withStore(setup, (store) => store.load("linked")))).toMatch(
        /Couldn't read/,
      );
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );

  it.effect("loads script files relative to the session cwd", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* setup.write(setup.join(setup.cwd, "draft.js"), script("drafted"));
      const loaded = yield* withStore(setup, (store) => store.loadPath("draft.js"));
      expect(loaded).toMatchObject({ name: "drafted", path: setup.join(setup.cwd, "draft.js") });
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );

  it.effect("lists both scopes once per name with diagnostics for invalid files", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      yield* setup.write(setup.join(setup.projectWorkflows, "a.js"), script("a"));
      yield* setup.write(setup.join(setup.userWorkflows, "a.js"), script("shadowed"));
      yield* setup.write(setup.join(setup.userWorkflows, "b.js"), script("b"));
      yield* setup.write(setup.join(setup.userWorkflows, "bad.js"), "nope");
      yield* setup.write(setup.join(setup.userWorkflows, "Not Valid.js"), script("ignored"));
      const listing = yield* withStore(setup, (store) => store.list);
      expect(listing.workflows.map((workflow) => [workflow.name, workflow.scope])).toEqual([
        ["a", "project"],
        ["b", "user"],
      ]);
      expect(listing.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
        setup.join(setup.userWorkflows, "bad.js"),
      ]);
      setup.trust.value = false;
      const untrusted = yield* withStore(setup, (store) => store.list);
      expect(untrusted.workflows.map((workflow) => workflow.meta.name)).toEqual(["shadowed", "b"]);
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );
});

describe("workflow run files", () => {
  const source = script("iterate");
  const runsOf = (setup: Fixture) => setup.join(setup.agentDirectory, "subagents", "workflow-runs");
  const permissions = (path: string) =>
    FileSystem.FileSystem.use((fs) => fs.stat(path)).pipe(Effect.map((info) => info.mode & 0o777));

  it.effect("saves each run's script privately, never over an existing run, for scriptPath", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const files = yield* withStore(setup, (store) =>
        store.createRunFiles("wf-a-1", source, new Set()),
      );
      expect(files.directory).toBe(setup.join(runsOf(setup), "wf-a-1"));
      expect(yield* fs.readFileString(files.script)).toBe(source);
      expect(yield* permissions(files.directory)).toBe(0o700);
      expect(yield* permissions(files.script)).toBe(0o600);

      const again = yield* Effect.flip(
        withStore(setup, (store) => store.createRunFiles("wf-a-1", "replaced", new Set())),
      );
      expect(again._tag).toBe("WorkflowRunFileError");
      expect(yield* fs.readFileString(files.script)).toBe(source);

      // The saved copy is what the main agent edits and starts again.
      const loaded = yield* withStore(setup, (store) => store.loadPath(files.script));
      expect(loaded.script.meta.name).toBe("iterate");
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );

  it.effect("appends results journal lines to a private file", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const lines = yield* withStore(setup, (store) =>
        Effect.gen(function* () {
          const files = yield* store.createRunFiles("wf-a-2", source, new Set());
          yield* store.appendRunJournal(files, '{"callId":1}');
          yield* store.appendRunJournal(files, '{"callId":2}');
          return files;
        }),
      );
      expect(yield* fs.readFileString(lines.journal)).toBe('{"callId":1}\n{"callId":2}\n');
      expect(yield* permissions(lines.journal)).toBe(0o600);
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );

  /** Run directories `wf-<prefix>-1..count`, each last written at its time in seconds. */
  const runDirectories = (
    setup: Fixture,
    prefix: string,
    count: number,
    writtenAt: (ordinal: number) => number,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (let ordinal = 1; ordinal <= count; ordinal++) {
        const directory = setup.join(runsOf(setup), `wf-${prefix}-${ordinal}`);
        yield* fs.makeDirectory(directory, { recursive: true });
        // Node reads numeric times as seconds since the epoch.
        yield* fs.utimes(directory, writtenAt(ordinal), writtenAt(ordinal));
      }
    });

  const removedOf = (left: ReadonlySet<string>, prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => `wf-${prefix}-${index + 1}`).filter(
      (name) => !left.has(name),
    );

  // A day old and more: outside the window in which another Pi process may still run them.
  const OLD = 1_767_225_600;
  const nowSeconds = Clock.currentTimeMillis.pipe(
    Effect.map((millis) => Math.floor(millis / 1_000)),
  );

  it.live("keeps the newest run directories, a live run's, and anything else", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const root = runsOf(setup);
      yield* runDirectories(setup, "a", 70, (ordinal) => OLD + ordinal);
      yield* fs.makeDirectory(setup.join(root, "notes"));
      yield* withStore(setup, (store) =>
        store.createRunFiles("wf-b-1", source, new Set(["wf-a-1"])),
      );
      const left = new Set(yield* fs.readDirectory(root));
      expect(removedOf(left, "a", 70)).toEqual([
        "wf-a-2",
        "wf-a-3",
        "wf-a-4",
        "wf-a-5",
        "wf-a-6",
        "wf-a-7",
      ]);
      expect(left.has("wf-a-1")).toBe(true);
      expect(left.has("wf-b-1")).toBe(true);
      expect(left.has("notes")).toBe(true);
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );

  it.live("never prunes a run directory written in the last day, whichever process runs it", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const recent = (yield* nowSeconds) - 60 * 60;
      // Other processes' runs, none live here, all written within the last hour.
      yield* runDirectories(setup, "a", 70, (ordinal) => recent + ordinal);
      yield* runDirectories(setup, "c", 3, (ordinal) => OLD + ordinal);
      yield* withStore(setup, (store) => store.createRunFiles("wf-b-1", source, new Set()));
      const left = new Set(yield* fs.readDirectory(runsOf(setup)));
      expect(removedOf(left, "a", 70)).toEqual([]);
      expect(removedOf(left, "c", 3)).toEqual(["wf-c-1", "wf-c-2", "wf-c-3"]);
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );

  it.live("keeps an old run's directory once the run appends to its journal again", () =>
    Effect.gen(function* () {
      const setup = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      yield* runDirectories(setup, "a", 70, (ordinal) => OLD + ordinal);
      yield* withStore(setup, (store) =>
        Effect.gen(function* () {
          const files = yield* store.createRunFiles("wf-d-1", source, new Set());
          yield* store.appendRunJournal(files, '{"callId":1}');
          // Quiet for a long time, then another line.
          yield* fs.utimes(files.directory, OLD, OLD);
          yield* store.appendRunJournal(files, '{"callId":2}');
          // Another process starts a run: wf-d-1 isn't live there, and it is the oldest by far.
          yield* store.createRunFiles("wf-e-1", source, new Set());
        }),
      );
      const left = new Set(yield* fs.readDirectory(runsOf(setup)));
      expect(left.has("wf-d-1")).toBe(true);
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );
});
