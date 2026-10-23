import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as os from "node:os";
import { nodeFsPromises as fs, nodePath as path } from "./support/node-builtins.ts";
import { runWorktreeHook, type WorktreeHookInput } from "../src/boundary/worktree-hook.ts";
import { capturedWarnings, unconfirmedShellCleanup } from "./support/unconfirmed-hook-cleanup.ts";

const environment = { PATH: "/usr/bin:/bin", GIT_DIR: "/parent/.git" };
const input = (worktreePath: string): WorktreeHookInput => ({
  event: "WorktreeCreate",
  workspaceId: "workspace-1",
  worktreePath,
  sourceCwd: "/source/packages/app",
  kind: "worker",
  runId: "run-1",
});
const run = (script: string, timeout?: number, cwd = process.cwd()) =>
  runWorktreeHook(
    { command: ["/bin/sh", "-c", script], ...(timeout !== undefined && { timeout }) },
    input(cwd),
    { environment },
  );

describe("worktree hook", () => {
  it.effect("runs in the tree with the event on stdin and without the parent's Git variables", () =>
    Effect.gen(function* () {
      const tree = yield* Effect.promise(() =>
        fs.mkdtemp(path.join(os.tmpdir(), "pi-worktree-hook-")),
      );
      yield* run('test -z "$GIT_DIR" && cat > stdin.json && pwd -P > cwd.txt', undefined, tree);
      const received = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        yield* Effect.promise(() => fs.readFile(path.join(tree, "stdin.json"), "utf8")),
      );
      expect(received).toEqual(input(tree));
      const cwd = yield* Effect.promise(() => fs.readFile(path.join(tree, "cwd.txt"), "utf8"));
      expect(cwd.trim()).toBe(yield* Effect.promise(() => fs.realpath(tree)));
      yield* Effect.promise(() => fs.rm(tree, { recursive: true, force: true }));
    }),
  );

  it.effect("succeeds without reading its stdin", () => run("exit 0"));

  it.effect("fails when it exits non-zero", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(run("echo 'missing lockfile' >&2; exit 3"));
      expect(error.message).toContain("missing lockfile");
    }),
  );

  it.effect("fails a hook that couldn't start, which left no process behind", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        runWorktreeHook({ command: ["pi-worktree-hook-missing-command"] }, input(process.cwd()), {
          environment,
        }),
      );
      expect(error.message).toContain("couldn't start");
    }),
  );

  it.effect(
    "warns about a group it can't confirm stopped without changing the hook's outcome",
    () =>
      Effect.gen(function* () {
        const { workspaceIds, layer } = capturedWarnings();
        const spy = unconfirmedShellCleanup();
        const outcomes = yield* Effect.all([
          run("exit 0").pipe(Effect.exit),
          run("exit 3").pipe(Effect.exit),
        ]).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => spy.mockRestore())));
        expect(outcomes.map((exit) => exit._tag)).toEqual(["Success", "Failure"]);
        expect(workspaceIds).toEqual(["workspace-1", "workspace-1"]);
      }),
  );

  it.live("stops a hook that runs past its timeout", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(run("sleep 30", 1));
      expect(error.message).toContain("timed out after 1s");
    }),
  );
});
