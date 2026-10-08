import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { nodeFilePlatformLayer, SafeFile } from "pi-cosmic-core";
import { makeWorkflowRecovery } from "../../src/workflow/recovery.ts";
import { startedWorkflowRunRecord, workflowRunRecordText } from "../../src/workflow/run-record.ts";
import { WorkflowStore } from "../../src/workflow/store.ts";

const script = (name: string) =>
  `export const meta = { name: ${JSON.stringify(name)}, description: "d" };\nreturn 1;\n`;

const fixture = Effect.gen(function* () {
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
  };
});

type Fixture = Effect.Success<typeof fixture>;

/** Runs a generator body, as `Effect.gen` would, with a fresh fixture on the real file system. */
const onDisk = <Eff extends Effect.Effect<unknown, unknown, unknown>, A>(
  body: (setup: Fixture, fs: FileSystem.FileSystem) => Generator<Eff, A, never>,
) =>
  Effect.gen(function* () {
    const setup = yield* fixture;
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.gen(() => body(setup, fs));
  }).pipe(Effect.provide(nodeFilePlatformLayer));

const withStore = <A, E>(
  setup: Fixture,
  use: (store: WorkflowStore["Service"]) => Effect.Effect<A, E>,
  agentDirectory = setup.agentDirectory,
) =>
  WorkflowStore.use(use).pipe(
    Effect.provide(
      WorkflowStore.layer({
        cwd: setup.cwd,
        agentDirectory,
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
    onDisk(function* (setup) {
      yield* setup.write(setup.join(setup.projectWorkflows, "review.js"), script("project-review"));
      yield* setup.write(setup.join(setup.userWorkflows, "review.js"), script("user-review"));
      const trusted = yield* withStore(setup, (store) => store.load("review"));
      expect(trusted.script.meta.name).toBe("project-review");
      setup.trust.value = false;
      const untrusted = yield* withStore(setup, (store) => store.load("review"));
      expect([untrusted.scope, untrusted.script.meta.name]).toEqual(["user", "user-review"]);
    }),
  );

  it.effect("rejects unsafe names, missing workflows and invalid scripts", () =>
    onDisk(function* (setup) {
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
    }),
  );

  it.effect("names the session's own directories and each saved workflow's path", () =>
    onDisk(function* (setup) {
      const path = setup.join(setup.userWorkflows, "review.js");
      yield* setup.write(path, script("review"));
      const listed = yield* withStore(setup, (store) => store.list);
      expect(listed.workflows.map((workflow) => workflow.path)).toEqual([path]);
      expect(listed.locations).toEqual({
        project: setup.projectWorkflows,
        projectTrusted: true,
        user: setup.userWorkflows,
      });
      const missing = yield* failureMessage(withStore(setup, (store) => store.load("missing")));
      expect(missing).toContain(setup.join(setup.projectWorkflows, "missing.js"));
      expect(missing).toContain(setup.join(setup.userWorkflows, "missing.js"));
      setup.trust.value = false;
      expect((yield* withStore(setup, (store) => store.locations)).projectTrusted).toBe(false);
    }),
  );

  it.effect("does not follow symlinked workflow files", () =>
    onDisk(function* (setup, fs) {
      yield* setup.write(setup.join(setup.root, "outside.js"), script("outside"));
      yield* fs.symlink(
        setup.join(setup.root, "outside.js"),
        setup.join(setup.userWorkflows, "linked.js"),
      );
      expect(yield* failureMessage(withStore(setup, (store) => store.load("linked")))).toMatch(
        /Couldn't read/,
      );
    }),
  );

  it.effect("loads a script file through a symlinked directory, but not a symlinked file", () =>
    onDisk(function* (setup, fs) {
      const real = setup.join(setup.root, "real");
      yield* fs.makeDirectory(real);
      yield* setup.write(setup.join(real, "draft.js"), script("drafted"));
      yield* setup.write(setup.join(setup.root, "outside.js"), script("outside"));
      yield* fs.symlink(setup.join(setup.root, "outside.js"), setup.join(real, "leaf.js"));
      // Like macOS's /tmp, a directory on the way to the script is a symlink.
      const linked = setup.join(setup.root, "linked");
      yield* fs.symlink(real, linked);
      const loaded = yield* withStore(setup, (store) =>
        store.loadPath(setup.join(linked, "draft.js")),
      );
      expect(loaded.name).toBe("drafted");
      expect(
        yield* failureMessage(
          withStore(setup, (store) => store.loadPath(setup.join(linked, "leaf.js"))),
        ),
      ).toMatch(/Couldn't read/);
    }),
  );

  it.effect("loads script files relative to the session cwd", () =>
    onDisk(function* (setup) {
      yield* setup.write(setup.join(setup.cwd, "draft.js"), script("drafted"));
      const loaded = yield* withStore(setup, (store) => store.loadPath("draft.js"));
      expect(loaded).toMatchObject({ name: "drafted", path: setup.join(setup.cwd, "draft.js") });
    }),
  );

  it.effect("lists both scopes once per name with diagnostics for invalid files", () =>
    onDisk(function* (setup) {
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
    }),
  );
});

describe("workflow run files", () => {
  const source = script("iterate");
  const runsOf = (setup: Fixture) => setup.join(setup.agentDirectory, "subagents", "workflow-runs");
  const permissions = (path: string) =>
    FileSystem.FileSystem.use((fs) => fs.stat(path)).pipe(Effect.map((info) => info.mode & 0o777));

  it.effect("saves each run's script privately, never over an existing run, for scriptPath", () =>
    onDisk(function* (setup, fs) {
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
    }),
  );

  it.effect("appends results journal lines to a private file", () =>
    onDisk(function* (setup, fs) {
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
    }),
  );

  it.effect("replaces a run's record atomically and privately, and reads it back", () =>
    onDisk(function* (setup, fs) {
      const read = yield* withStore(setup, (store) =>
        Effect.gen(function* () {
          const files = yield* store.createRunFiles("wf-r-1", source, new Set());
          yield* store.writeRunRecord(files, '{"state":"running"}');
          yield* store.writeRunRecord(files, '{"state":"completed"}');
          return yield* store.readRunRecord("wf-r-1");
        }),
      );
      expect(read?.text.trim()).toBe('{"state":"completed"}');
      expect(read?.files.record).toBe(setup.join(runsOf(setup), "wf-r-1", "run.json"));
      expect(yield* permissions(read?.files.record ?? "")).toBe(0o600);
      // No temporary file is left beside the record.
      expect((yield* fs.readDirectory(read?.files.directory ?? "")).toSorted()).toEqual([
        "run.json",
        "script.js",
      ]);
    }),
  );

  it.effect("reads saved workflows and run files through a symlinked agent directory", () =>
    onDisk(function* (setup, fs) {
      yield* setup.write(setup.join(setup.userWorkflows, "review.js"), script("review"));
      // A dotfile manager links the agent directory from elsewhere.
      const linked = setup.join(setup.root, "linked-agent");
      yield* fs.symlink(setup.agentDirectory, linked);
      const sessionKey = "session-linked";
      const found = yield* withStore(
        setup,
        (store) =>
          Effect.gen(function* () {
            const files = yield* store.createRunFiles("wf-s-1", source, new Set());
            const record = startedWorkflowRunRecord(
              { id: "wf-s-1", name: "iterate", source: { kind: "inline" }, startedAt: 1 },
              sessionKey,
              { pid: 1, bootedAt: 0 },
            );
            yield* store.writeRunRecord(
              files,
              workflowRunRecordText({ ...record, state: "interrupted" }),
            );
            yield* store.appendRunJournal(
              files,
              '{"state":"completed","key":"k1","outputTokens":3,"result":"done"}',
            );
            const recovery = makeWorkflowRecovery({ store, sessionKey });
            return {
              saved: yield* store.load("review"),
              copy: yield* store.loadPath(files.script),
              replay: yield* recovery.replay("wf-s-1"),
              owed: yield* recovery.interrupted(() => Effect.succeed(false)),
            };
          }),
        linked,
      );
      expect(found.saved.script.meta.name).toBe("review");
      expect(found.copy.script.meta.name).toBe("iterate");
      expect(found.replay.take("k1")?.result).toBe("done");
      expect(found.owed).toEqual([expect.objectContaining({ runId: "wf-s-1", finished: 1 })]);
    }),
  );

  it.effect("finds no record for an unknown, pruned or malformed run id", () =>
    onDisk(function* (setup) {
      const found = yield* withStore(setup, (store) =>
        Effect.all([
          store.readRunRecord("wf-r-9"),
          store.readRunRecord("../../etc"),
          store
            .createRunFiles("wf-r-2", source, new Set())
            .pipe(Effect.andThen(store.readRunRecord("wf-r-2"))),
        ]),
      );
      expect(found).toEqual([undefined, undefined, undefined]);
    }),
  );

  it.effect("saves full results privately and reads them back only within a bound", () =>
    onDisk(function* (setup) {
      const { name, files, whole, bounded, outside } = yield* withStore(setup, (store) =>
        Effect.gen(function* () {
          const files = yield* store.createRunFiles("wf-r-3", source, new Set());
          const name = yield* store.writeRunResult(files, 1, '"full value"');
          return {
            name,
            files,
            whole: yield* store.readRunResult(files, name, 1_024),
            bounded: yield* store.readRunResult(files, name, 4),
            outside: yield* store.readRunResult(files, "../wf-r-3/script.js", 1_024),
          };
        }),
      );
      expect(name).toBe("results/1.json");
      expect(whole).toBe('"full value"');
      expect(bounded).toBeUndefined();
      expect(outside).toBeUndefined();
      expect(yield* permissions(setup.join(files.directory, "results", "1.json"))).toBe(0o600);
    }),
  );

  it.effect("reads only the complete journal lines within its bound", () =>
    onDisk(function* (setup, fs) {
      const reads = yield* withStore(setup, (store) =>
        Effect.gen(function* () {
          const files = yield* store.createRunFiles("wf-r-4", source, new Set());
          const none = yield* store.readRunJournal(files, 1_024);
          yield* store.appendRunJournal(files, '{"callId":1}');
          yield* store.appendRunJournal(files, '{"callId":2}');
          // A line still being written has no newline yet.
          yield* fs.writeFileString(files.journal, '{"call', { flag: "a" });
          return [
            none,
            yield* store.readRunJournal(files, 1_024),
            yield* store.readRunJournal(files, 20),
          ];
        }),
      );
      expect(reads).toEqual([[], ['{"callId":1}', '{"callId":2}'], ['{"callId":1}']]);
    }),
  );

  it.effect("refuses a results journal that links to a file elsewhere", () =>
    onDisk(function* (setup, fs) {
      const outside = setup.join(setup.root, "outside.jsonl");
      yield* setup.write(outside, '{"callId":1}\n');
      const refused = yield* withStore(setup, (store) =>
        Effect.gen(function* () {
          const files = yield* store.createRunFiles("wf-r-6", source, new Set());
          yield* fs.symlink(outside, files.journal);
          return yield* Effect.flip(store.readRunJournal(files, 1_024));
        }),
      );
      expect(refused._tag).toBe("WorkflowRunFileError");
    }),
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
    onDisk(function* (setup, fs) {
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
    }),
  );

  it.live("never prunes a run directory written in the last day, whichever process runs it", () =>
    onDisk(function* (setup, fs) {
      const recent = (yield* nowSeconds) - 60 * 60;
      // Other processes' runs, none live here, all written within the last hour.
      yield* runDirectories(setup, "a", 70, (ordinal) => recent + ordinal);
      yield* runDirectories(setup, "c", 3, (ordinal) => OLD + ordinal);
      yield* withStore(setup, (store) => store.createRunFiles("wf-b-1", source, new Set()));
      const left = new Set(yield* fs.readDirectory(runsOf(setup)));
      expect(removedOf(left, "a", 70)).toEqual([]);
      expect(removedOf(left, "c", 3)).toEqual(["wf-c-1", "wf-c-2", "wf-c-3"]);
    }),
  );

  it.live("keeps an old run's directory once the run appends to its journal again", () =>
    onDisk(function* (setup, fs) {
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
    }),
  );

  it.live("lists the records it keeps from the most recently written run directories first", () =>
    onDisk(function* (setup, fs) {
      const listed = yield* withStore(setup, (store) =>
        Effect.gen(function* () {
          for (const [ordinal, writtenAt] of [OLD + 3, OLD + 1, OLD + 2].entries()) {
            const files = yield* store.createRunFiles(`wf-l-${ordinal + 1}`, source, new Set());
            yield* store.writeRunRecord(files, `{"ordinal":${ordinal + 1}}`);
            yield* fs.utimes(files.directory, writtenAt, writtenAt);
          }
          // A directory without a record is skipped.
          yield* store.createRunFiles("wf-l-4", source, new Set());
          return {
            all: yield* store.listRunRecords(3, () => true),
            // The limit counts only the records kept, however many newer ones are left out.
            kept: yield* store.listRunRecords(1, (file) => file.runId !== "wf-l-1"),
          };
        }),
      );
      expect(listed.all.map((file) => file.runId)).toEqual(["wf-l-1", "wf-l-3", "wf-l-2"]);
      expect(listed.kept.map((file) => file.runId)).toEqual(["wf-l-3"]);
    }),
  );
});
