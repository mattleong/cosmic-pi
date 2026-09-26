import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as snapshot from "../../src/boundary/git-worktree-snapshot.ts";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import { git, workspaceIO } from "../../src/boundary/git-worktree-process.ts";
import { WorkspaceService } from "../../src/workspace/service.ts";
import type { WorkspaceRecord } from "../../src/workspace/model.ts";
import { commitRepository, io, readText, temporaryDirectory } from "./fixtures/repository.ts";

const fixture = <A, E>(
  test: (agent: string, source: string) => Effect.Effect<A, E, WorkspaceService>,
) =>
  Effect.gen(function* () {
    const temporary = yield* temporaryDirectory("pi-seed-recovery-");
    const source = path.join(temporary, "source");
    const agent = path.join(temporary, "agent");
    yield* commitRepository(source, [["main.ts", "baseline\n"]]);
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
          const { records } = yield* service.listAll();
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
              yield* io(() => fs.mkdir(seed));
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
              yield* io(() =>
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
              expect(yield* io(() => fs.readdir(directory))).not.toContain("seed");
              expect(yield* git(repository, ["worktree", "list", "--porcelain"])).not.toContain(
                seed,
              );
              expect(yield* readText(predecessor.cwd, "main.ts")).toBe("baseline\n");
            } else {
              yield* recovered.recoverDiscard(target).pipe(Effect.flip);
              expect((yield* recovered.inspect(target)).status).toBe("creating");
              expect(yield* io(() => fs.readdir(directory))).toContain("seed");
            }
          }).pipe(Effect.provide(WorkspaceService.layer({ agentDirectory: agent })));
        }),
      ),
    60_000,
  );
}
