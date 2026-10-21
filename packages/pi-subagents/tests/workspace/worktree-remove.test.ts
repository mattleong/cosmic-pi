import { afterAll, describe, expect, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as os from "node:os";
import * as hookRunner from "../../src/boundary/worktree-hook.ts";
import {
  nodeFsPromises as fs,
  nodeMkdirSync,
  nodePath as path,
} from "../../src/boundary/node-builtins.ts";
import type { WorkspaceHandle } from "../../src/workspace/model.ts";
import type { WorkspaceServiceContract } from "../../src/workspace/service.ts";
import {
  exists,
  failureOf,
  io,
  readText,
  workspaceTarget,
  workspaceTests,
  writeFile,
} from "./fixtures/repository.ts";

// Hooks are fixed when the engine starts, so they log to one directory for the whole file.
// Logs name workspaces by their unique IDs, so another run's leftovers can't match.
const logs = path.join(os.tmpdir(), `pi-worktree-remove-${process.pid}`);
nodeMkdirSync(logs, { recursive: true });
afterAll(() => fs.rm(logs, { recursive: true, force: true }));
const log = path.join(logs, "remove.log");

// Logs its stdin, then fails when the tree asks it to.
const test = workspaceTests(
  [
    ["src/main.ts", "baseline\n"],
    [".gitignore", "scratch/\n"],
  ],
  [],
  {
    worktreeRemove: [
      { command: ["/bin/sh", "-c", 'cat >> "$1"; test ! -e scratch/fail-remove', "sh", log] },
    ],
  },
);

const decodeLoggedInput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      event: Schema.String,
      workspaceId: Schema.String,
      worktreePath: Schema.String,
      sourceCwd: Schema.String,
      kind: Schema.String,
    }),
  ),
);

/** The stdin objects WorktreeRemove hooks logged for `workspaceId`, in order. */
const removals = (workspaceId: string) =>
  readText(log).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.flatMap((text) =>
      Effect.forEach(text.split("\n").filter(Boolean), (line) => decodeLoggedInput(line)),
    ),
    Effect.map((inputs) => inputs.filter((input) => input.workspaceId === workspaceId)),
    Effect.orDie,
  );

const originalHook = hookRunner.runWorktreeHook;
// Every WorktreeRemove hook fails with its process cleanup unconfirmed while the spy is installed;
// WorktreeCreate hooks run as usual.
const unconfirmedRemoval = () =>
  vi.spyOn(hookRunner, "runWorktreeHook").mockImplementation((hook, input, options) =>
    input.event === "WorktreeCreate"
      ? originalHook(hook, input, options)
      : Effect.fail(
          new hookRunner.WorktreeHookError({
            message: "Left processes.",
            cleanupUnconfirmed: true,
          }),
        ),
  );

const prepareEdit = (service: WorkspaceServiceContract, handle: WorkspaceHandle) =>
  Effect.gen(function* () {
    yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
    const revision = yield* service.freeze(workspaceTarget(handle));
    const prepared = yield* service.prepare({
      ...workspaceTarget(handle),
      revisionId: revision.revisionId,
    });
    return { revision, prepared };
  });

describe("WorktreeRemove hooks", () => {
  test("run in the prepared tree and then the worker before discard removes them", function* (service, root) {
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    const { prepared } = yield* prepareEdit(service, handle);
    yield* service.discard(workspaceTarget(handle));
    expect(yield* removals(handle.workspaceId)).toEqual([
      {
        event: "WorktreeRemove",
        workspaceId: handle.workspaceId,
        worktreePath: prepared.cwd,
        sourceCwd: root,
        kind: "prepare",
      },
      {
        event: "WorktreeRemove",
        workspaceId: handle.workspaceId,
        worktreePath: handle.cwd,
        sourceCwd: root,
        kind: "worker",
      },
    ]);
    expect(yield* exists(handle.cwd)).toBe(false);
    expect(yield* exists(prepared.cwd)).toBe(false);
  });

  test("run before integration cleans up its trees", function* (service, root) {
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    const { revision, prepared } = yield* prepareEdit(service, handle);
    yield* service.integrate({
      ...workspaceTarget(handle),
      revisionId: revision.revisionId,
      preparationId: prepared.preparationId,
    });
    expect((yield* removals(handle.workspaceId)).map((input) => input.kind)).toEqual([
      "prepare",
      "worker",
    ]);
    expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
    expect(yield* exists(handle.cwd)).toBe(false);
  });

  test("never run in a tree create or prepare rolls back", function* (service, root) {
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
    const revision = yield* service.freeze(workspaceTarget(handle));
    yield* writeFile(path.join(root, "src/main.ts"), "parent\n");
    yield* failureOf(
      service.prepare({ ...workspaceTarget(handle), revisionId: revision.revisionId }),
    );
    expect(yield* removals(handle.workspaceId)).toEqual([]);
  });

  test("a failing hook never blocks removal", function* (service, root) {
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* io(() => fs.mkdir(path.join(handle.cwd, "scratch")));
    yield* writeFile(path.join(handle.cwd, "scratch/fail-remove"), "");
    yield* service.discard(workspaceTarget(handle));
    expect((yield* removals(handle.workspaceId)).map((input) => input.kind)).toEqual(["worker"]);
    expect(yield* exists(handle.cwd)).toBe(false);
    const record = (yield* service.listAll).records.find(
      (entry) => entry.handle.workspaceId === handle.workspaceId,
    );
    expect(record?.status).toBe("discarded");
  });

  test("unconfirmed hook cleanup never blocks removal", function* (service, root) {
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    const spy = unconfirmedRemoval();
    yield* service
      .discard(workspaceTarget(handle))
      .pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
    expect(yield* exists(handle.cwd)).toBe(false);
    expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("discarded");
  });

  test("a failed WorktreeCreate hook withdraws its preparation, removing the test tree", function* (service, root) {
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    const { revision, prepared } = yield* prepareEdit(service, handle);
    const failure = yield* failureOf(
      service.runCreateHooks({
        ...workspaceTarget(handle),
        preparationId: prepared.preparationId,
        hooks: [{ command: ["/bin/sh", "-c", "exit 3"] }],
      }),
    );
    expect(failure.cleanupUnconfirmed).not.toBe(true);
    expect((yield* removals(handle.workspaceId)).map((input) => input.kind)).toEqual(["prepare"]);
    expect(yield* exists(prepared.cwd)).toBe(false);
    const record = yield* service.inspect(workspaceTarget(handle));
    expect(record.status).toBe("frozen");
    expect(record.preparation).toBeUndefined();
    const integration = {
      ...workspaceTarget(handle),
      revisionId: revision.revisionId,
      processCleanupConfirmed: true as const,
    };
    expect(
      (yield* failureOf(
        service.integrate({ ...integration, preparationId: prepared.preparationId }),
      )).operation,
    ).toBe("integrate");
    expect(yield* readText(root, "src/main.ts")).toBe("baseline\n");
    // The reviewed revision can still be prepared again.
    const again = yield* service.prepare({ ...integration });
    yield* service.integrate({ ...integration, preparationId: again.preparationId });
    expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
  });
});

const hungPid = path.join(logs, "hung-remove.pid");
// The first hook can't start; the second outlives its timeout.
const hung = workspaceTests([["src/main.ts", "baseline\n"]], [], {
  worktreeRemove: [
    { command: ["pi-worktree-remove-missing-command"] },
    { command: ["/bin/sh", "-c", 'echo $$ > "$1"; exec sleep 30', "sh", hungPid], timeout: 1 },
  ],
});

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("WorktreeRemove hooks that fail or hang", () => {
  hung("are killed at their timeout, and the tree is removed anyway", function* (service, root) {
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* service.discard(workspaceTarget(handle));
    const pid = Number((yield* readText(hungPid)).trim());
    expect(processAlive(pid)).toBe(false);
    expect(yield* exists(handle.cwd)).toBe(false);
    expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("discarded");
  });
});
