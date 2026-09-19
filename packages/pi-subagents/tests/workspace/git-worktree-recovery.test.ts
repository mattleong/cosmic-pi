import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as os from "node:os";
import * as snapshot from "../../src/boundary/git-worktree-snapshot.ts";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import { git, workspaceIO } from "../../src/boundary/git-worktree-process.ts";
import { WorkspaceService } from "../../src/workspace/service.ts";
import type { WorkspaceRecord } from "../../src/workspace/model.ts";

const fixture = <A, E>(
  test: (agent: string, source: string) => Effect.Effect<A, E, WorkspaceService>,
) =>
  Effect.gen(function* () {
    const temporary = yield* Effect.acquireRelease(
      workspaceIO("fixture", () =>
        fs.mkdtemp(path.join(os.tmpdir(), "pi-seed-recovery-")).then((dir) => fs.realpath(dir)),
      ),
      (dir) =>
        workspaceIO("fixture", () => fs.rm(dir, { recursive: true, force: true })).pipe(
          Effect.ignore,
        ),
    );
    const source = path.join(temporary, "source");
    const agent = path.join(temporary, "agent");
    yield* workspaceIO("fixture", () => fs.mkdir(source));
    yield* git(source, ["init", "--template="]);
    yield* workspaceIO("fixture", () => fs.writeFile(path.join(source, "main.ts"), "baseline\n"));
    yield* git(source, ["add", "main.ts"]);
    yield* git(source, ["commit", "-m", "fixture"]);
    return yield* test(agent, source).pipe(
      Effect.provide(WorkspaceService.layer({ agentDirectory: agent })),
    );
  });

for (const mismatch of ["none", "missing provenance", "owner", "source", "registration"] as const) {
  it.live(
    `recovers a failed fork safely: ${mismatch}`,
    () =>
      fixture((agent, source) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          const predecessor = yield* service.create({ sourceCwd: source, ownerId: "parent" });
          const original = snapshot.captureSnapshot;
          const spy = vi
            .spyOn(snapshot, "captureSnapshot")
            .mockImplementation((...args) =>
              path.basename(args[0]) === "seed"
                ? workspaceIO("snapshot", () =>
                    Promise.reject(
                      Object.assign(new Error("injected IO failure"), { code: "EIO" }),
                    ),
                  )
                : original(...args),
            );
          yield* service
            .fork({ ...predecessor, processCleanupConfirmed: true })
            .pipe(Effect.flip, Effect.ensuring(Effect.sync(() => spy.mockRestore())));
          const records = yield* service.listAll();
          const failed = records.find((record) => record.status === "creating")!;
          expect(failed.predecessorWorkspaceId).toBe(predecessor.workspaceId);
          const directory = path.join(agent, "git-workspaces", failed.handle.workspaceId);
          const seed = path.join(directory, "seed");
          const repository = path.join(
            agent,
            "git-workspaces",
            predecessor.workspaceId,
            "repo.git",
          );
          expect(yield* git(repository, ["worktree", "list", "--porcelain"])).toContain(seed);
          if (mismatch !== "none") {
            if (mismatch === "registration") {
              yield* git(repository, ["worktree", "remove", "--force", seed]);
              // An unrelated real checkout at the same path is never deletion authority.
              yield* workspaceIO("fixture", () => fs.mkdir(seed));
              yield* git(seed, ["init", "--template="]);
            } else {
              let changed: WorkspaceRecord = failed;
              if (mismatch === "missing provenance") {
                const { predecessorWorkspaceId: _removed, ...historical } = failed;
                changed = historical;
              } else {
                changed = {
                  ...failed,
                  handle: {
                    ...failed.handle,
                    ...(mismatch === "owner"
                      ? { ownerId: "other" }
                      : {
                          sourceRoot: path.join(source, "other"),
                          sourceCwd: path.join(source, "other"),
                        }),
                  },
                };
              }
              yield* workspaceIO("fixture", () =>
                fs.writeFile(path.join(directory, "record.json"), JSON.stringify(changed)),
              );
            }
          }
          const target = {
            workspaceId: failed.handle.workspaceId,
            ownerId: mismatch === "owner" ? "other" : "parent",
            processCleanupConfirmed: true as const,
            recoveryRiskAccepted: true as const,
          };
          // Recovery must work in a fresh session without adopting the failed writer.
          yield* Effect.gen(function* () {
            const recovered = yield* WorkspaceService;
            if (mismatch === "none") {
              yield* recovered.recoverDiscard(target);
              expect((yield* recovered.inspect(target)).status).toBe("discarded");
              expect(yield* workspaceIO("fixture", () => fs.readdir(directory))).not.toContain(
                "seed",
              );
              expect(yield* git(repository, ["worktree", "list", "--porcelain"])).not.toContain(
                seed,
              );
              expect(
                yield* workspaceIO("fixture", () =>
                  fs.readFile(path.join(predecessor.cwd, "main.ts"), "utf8"),
                ),
              ).toBe("baseline\n");
            } else {
              yield* recovered.recoverDiscard(target).pipe(Effect.flip);
              expect((yield* recovered.inspect(target)).status).toBe("creating");
              expect(yield* workspaceIO("fixture", () => fs.readdir(directory))).toContain("seed");
            }
          }).pipe(Effect.provide(WorkspaceService.layer({ agentDirectory: agent })));
        }),
      ),
    60_000,
  );
}
