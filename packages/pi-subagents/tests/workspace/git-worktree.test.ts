import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import * as publication from "../../src/boundary/git-worktree-integration.ts";
import * as Effect from "effect/Effect";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import { git } from "../../src/boundary/git-worktree-process.ts";
import { WorkspaceService } from "../../src/workspace/service.ts";
import { WriterLeaseService } from "../../src/boundary/writer-lease.ts";
import type { WorkspaceHandle } from "../../src/workspace/model.ts";
import {
  commitRepository,
  exists,
  fails,
  io,
  readText,
  temporaryDirectory,
} from "./fixtures/repository.ts";

const fixture = <A, E>(
  test: (root: string, agent: string) => Effect.Effect<A, E, WorkspaceService>,
) =>
  Effect.gen(function* () {
    const temporary = yield* temporaryDirectory("pi-worktree-test-");
    const root = path.join(temporary, "source"),
      agent = path.join(temporary, "agent");
    yield* io(() => fs.mkdir(agent, { mode: 0o700 }));
    yield* commitRepository(root, [
      ["src/main.ts", "baseline\n"],
      ["other.txt", "other\n"],
      ["binary.dat", new Uint8Array([0, 255, 13, 10])],
      [".env", "SECRET=never-copy-this-head-value\n"],
      [".gitignore", "ignored.ts\n"],
    ]);
    return yield* test(root, agent).pipe(
      Effect.provide(WorkspaceService.layer({ agentDirectory: agent })),
    );
  });
const target = (handle: WorkspaceHandle) => ({
  workspaceId: handle.workspaceId,
  ownerId: handle.ownerId,
  processCleanupConfirmed: true as const,
});
/** Freezes and prepares a workspace, returning the matching integration request. */
const prepareIntegration = (handle: WorkspaceHandle) =>
  Effect.gen(function* () {
    const service = yield* WorkspaceService;
    const revision = yield* service.freeze(target(handle));
    const prepared = yield* service.prepare({ ...target(handle), revisionId: revision.revisionId });
    const integration = {
      ...target(handle),
      revisionId: revision.revisionId,
      preparationId: prepared.preparationId,
    };
    return { revision, prepared, integration };
  });

it.live(
  "rejects an empty ancestor created after prepare, including an active nested writer",
  () =>
    fixture((root, agent) =>
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
        yield* io(() => fs.mkdir(path.join(handle.cwd, "feature/nested"), { recursive: true }));
        yield* io(() => fs.writeFile(path.join(handle.cwd, "feature/nested/new.ts"), "new\n"));
        const { integration } = yield* prepareIntegration(handle);
        const ancestor = path.join(root, "feature");
        yield* io(() => fs.mkdir(ancestor));
        expect((yield* service.integrate(integration).pipe(Effect.flip)).message).toContain(
          "ancestors changed",
        );
        const leases = yield* WriterLeaseService.pipe(
          Effect.provide(WriterLeaseService.layer({ agentDirectory: agent })),
        );
        const cwd = yield* leases.canonicalize(ancestor);
        yield* Effect.acquireUseRelease(
          leases.acquire({ cwd, runId: "nested-writer" }),
          () =>
            Effect.gen(function* () {
              expect((yield* service.integrate(integration).pipe(Effect.flip)).message).toContain(
                "ancestors changed",
              );
              expect(yield* io(() => fs.readdir(ancestor))).toEqual([]);
              expect((yield* service.inspect(target(handle))).status).toBe("prepared");
            }),
          (lease) => leases.release(lease).pipe(Effect.orDie),
        );
      }),
    ),
  60_000,
);

it.live(
  "rejects an unleased ancestor appearing between lease revalidation and publication discovery",
  () =>
    fixture((root, agent) =>
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
        yield* io(() => fs.mkdir(path.join(handle.cwd, "feature")));
        yield* io(() => fs.writeFile(path.join(handle.cwd, "feature/new.ts"), "new\n"));
        const { integration } = yield* prepareIntegration(handle);
        const leases = yield* WriterLeaseService.pipe(
          Effect.provide(WriterLeaseService.layer({ agentDirectory: agent })),
        );
        const ancestor = path.join(root, "feature");
        const original = publication.publishWorkspace;
        let acquired = false;
        const spy = vi.spyOn(publication, "publishWorkspace").mockImplementation((...args) =>
          Effect.gen(function* () {
            // This owned boundary is called only after requiredLeaseDirectories succeeds.
            yield* io(() => fs.mkdir(ancestor));
            const cwd = yield* leases.canonicalize(ancestor).pipe(Effect.orDie);
            return yield* Effect.acquireUseRelease(
              leases.acquire({ cwd, runId: "gap-writer" }).pipe(Effect.orDie),
              () =>
                Effect.gen(function* () {
                  acquired = true;
                  return yield* original(...args);
                }),
              (lease) => leases.release(lease).pipe(Effect.orDie),
            );
          }),
        );
        const failure = yield* service
          .integrate(integration)
          .pipe(Effect.flip, Effect.ensuring(Effect.sync(() => spy.mockRestore())));
        expect(acquired).toBe(true);
        expect(failure.message).toContain("ancestors changed");
        expect(yield* io(() => fs.readdir(ancestor))).toEqual([]);
        expect((yield* service.inspect(target(handle))).status).toBe("prepared");
      }),
    ),
  60_000,
);

const addInternalAliases = (root: string) =>
  Effect.gen(function* () {
    yield* io(() => fs.writeFile(path.join(root, "AGENTS.md"), "original instructions\n"));
    yield* io(() => fs.symlink("AGENTS.md", path.join(root, "CLAUDE.md")));
    yield* io(() => fs.symlink("../AGENTS.md", path.join(root, "src/alias.md")));
    yield* git(root, ["add", "--", "AGENTS.md", "CLAUDE.md", "src/alias.md"]);
  });

it.live(
  "preserves tracked internal aliases through snapshot, fork and regular-file integration",
  () =>
    fixture((root) =>
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        yield* addInternalAliases(root);
        yield* io(() => fs.writeFile(path.join(root, "AGENTS.md"), "current instructions\n"));
        const index = yield* io(() => fs.readFile(path.join(root, ".git/index")));
        const head = yield* git(root, ["rev-parse", "HEAD"]);
        const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
        expect(yield* io(() => fs.readlink(path.join(handle.cwd, "CLAUDE.md")))).toBe("AGENTS.md");
        expect(yield* readText(handle.cwd, "src/alias.md")).toBe("current instructions\n");
        const fork = yield* service.fork(target(handle));
        expect(yield* io(() => fs.readlink(path.join(fork.cwd, "CLAUDE.md")))).toBe("AGENTS.md");
        yield* io(() =>
          fs.writeFile(path.join(handle.cwd, "AGENTS.md"), "reviewed instructions\n"),
        );
        const { revision, prepared, integration } = yield* prepareIntegration(handle);
        expect(revision.changedPaths).toEqual(["AGENTS.md"]);
        expect(yield* io(() => fs.readlink(path.join(prepared.cwd, "CLAUDE.md")))).toBe(
          "AGENTS.md",
        );
        yield* service.integrate(integration);
        expect(yield* io(() => fs.readlink(path.join(root, "CLAUDE.md")))).toBe("AGENTS.md");
        expect(yield* readText(root, "CLAUDE.md")).toBe("reviewed instructions\n");
        expect(yield* io(() => fs.readFile(path.join(root, ".git/index")))).toEqual(index);
        expect(yield* git(root, ["rev-parse", "HEAD"])).toBe(head);
      }),
    ),
  60_000,
);

for (const linkTarget of [
  "/etc/passwd",
  "../outside.txt",
  ".env",
  "missing.md",
  "src",
  "CLAUDE.md",
  "src/alias.md",
  ".git/config",
  "missing/../AGENTS.md",
  "node_modules/../AGENTS.md",
  "./AGENTS.md",
  "\uFEFFAGENTS.md",
]) {
  it.live(
    `rejects unsafe tracked alias target ${linkTarget} before retaining a workspace`,
    () =>
      fixture((root) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          yield* addInternalAliases(root);
          yield* io(() => fs.unlink(path.join(root, "CLAUDE.md")));
          yield* io(() => fs.symlink(linkTarget, path.join(root, "CLAUDE.md")));
          const index = yield* io(() => fs.readFile(path.join(root, ".git/index")));
          expect(yield* fails(service.create({ sourceCwd: root, ownerId: "parent" }))).toBe(true);
          expect(yield* service.listAll()).toEqual({ records: [], unavailable: [] });
          expect(yield* io(() => fs.readFile(path.join(root, ".git/index")))).toEqual(index);
        }),
      ),
    60_000,
  );
}

it.live(
  "does not normalize traversal through an excluded external directory symlink",
  () =>
    fixture((root) =>
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        yield* addInternalAliases(root);
        const outside = path.join(path.dirname(root), "external");
        yield* io(() => fs.mkdir(path.join(outside, "nested"), { recursive: true }));
        yield* io(() => fs.writeFile(path.join(outside, "AGENTS.md"), "outside instructions\n"));
        yield* io(() => fs.symlink(path.join(outside, "nested"), path.join(root, "node_modules")));
        yield* io(() => fs.unlink(path.join(root, "CLAUDE.md")));
        yield* io(() => fs.symlink("node_modules/../AGENTS.md", path.join(root, "CLAUDE.md")));
        expect(yield* fails(service.create({ sourceCwd: root, ownerId: "parent" }))).toBe(true);
        expect(yield* service.listAll()).toEqual({ records: [], unavailable: [] });
        expect(yield* readText(outside, "AGENTS.md")).toBe("outside instructions\n");
      }),
    ),
  60_000,
);

for (const change of ["remove", "retarget", "regular", "add"] as const) {
  it.live(
    `rejects worker symlink ${change} without publishing earlier regular-file edits`,
    () =>
      fixture((root) =>
        Effect.gen(function* () {
          const service = yield* WorkspaceService;
          yield* addInternalAliases(root);
          const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
          yield* io(() => fs.writeFile(path.join(handle.cwd, "AGENTS.md"), "must not publish\n"));
          if (change === "add") {
            yield* io(() => fs.symlink("AGENTS.md", path.join(handle.cwd, "extra.md")));
            yield* git(handle.cwd, ["add", "--", "extra.md"]);
          } else {
            yield* io(() => fs.unlink(path.join(handle.cwd, "CLAUDE.md")));
            if (change === "retarget")
              yield* io(() => fs.symlink("other.txt", path.join(handle.cwd, "CLAUDE.md")));
            if (change === "regular")
              yield* io(() => fs.writeFile(path.join(handle.cwd, "CLAUDE.md"), "regular now\n"));
          }
          expect(yield* fails(service.freeze(target(handle)))).toBe(true);
          expect(yield* readText(root, "AGENTS.md")).toBe("original instructions\n");
          expect((yield* service.inspect(target(handle))).status).toBe("active");
        }),
      ),
    60_000,
  );
}

it.live(
  "snapshots current edits without HEAD secrets and publishes binary/mode/deletes without staging",
  () =>
    fixture((root) =>
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        yield* io(() => fs.writeFile(path.join(root, "src/main.ts"), "staged\n"));
        yield* git(root, ["add", "--", "src/main.ts"]);
        yield* io(() => fs.writeFile(path.join(root, "src/main.ts"), "current\n"));
        yield* io(() => fs.writeFile(path.join(root, "src/new.ts"), "untracked source\n"));
        yield* io(() => fs.writeFile(path.join(root, "ignored.ts"), "ignored\n"));
        const index = yield* io(() => fs.readFile(path.join(root, ".git/index")));
        const head = yield* git(root, ["rev-parse", "HEAD"]);
        const handle = yield* service.create({
          sourceCwd: path.join(root, "src"),
          ownerId: "parent",
        });
        expect(handle.cwd).not.toContain(root);
        expect(path.basename(handle.cwd)).toBe("src");
        expect(yield* readText(handle.cwd, "main.ts")).toBe("current\n");
        expect(yield* readText(handle.cwd, "new.ts")).toBe("untracked source\n");
        const worker = path.dirname(handle.cwd);
        expect(yield* exists(path.join(worker, ".env"))).toBe(false);
        expect(yield* exists(path.join(worker, "ignored.ts"))).toBe(false);
        expect(yield* git(worker, ["log", "--all", "--format=", "--name-only"])).not.toContain(
          ".env",
        );
        yield* io(() => fs.writeFile(path.join(handle.cwd, "main.ts"), "worker\n"));
        yield* io(() =>
          fs.writeFile(path.join(worker, "binary.dat"), new Uint8Array([0, 250, 1, 2])),
        );
        yield* io(() => fs.chmod(path.join(handle.cwd, "main.ts"), 0o755));
        yield* io(() => fs.unlink(path.join(worker, "other.txt")));
        yield* io(() => fs.mkdir(path.join(worker, "feature/nested"), { recursive: true }));
        yield* io(() =>
          fs.writeFile(path.join(worker, "feature/nested/new.ts"), "new nested source\n"),
        );
        const {
          revision: review,
          prepared: preparation,
          integration,
        } = yield* prepareIntegration(handle);
        expect(review.changedPaths).toContain("binary.dat");
        expect(yield* readText(preparation.cwd, "main.ts")).toBe("worker\n");
        yield* service.integrate(integration);
        expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
        expect(yield* readText(root, "feature/nested/new.ts")).toBe("new nested source\n");
        expect(preparation.leaseDirectories).toEqual([root, path.join(root, "src")]);
        expect(yield* io(() => fs.readFile(path.join(root, "binary.dat")))).toEqual(
          Buffer.from([0, 250, 1, 2]),
        );
        expect((yield* io(() => fs.stat(path.join(root, "src/main.ts")))).mode & 0o111).not.toBe(0);
        expect(yield* exists(path.join(root, "other.txt"))).toBe(false);
        expect(yield* io(() => fs.readFile(path.join(root, ".git/index")))).toEqual(index);
        expect(yield* git(root, ["rev-parse", "HEAD"])).toBe(head);
        expect(yield* readText(root, ".env")).toBe("SECRET=never-copy-this-head-value\n");
      }),
    ),
  60_000,
);

it.live(
  "binds acceptance to unchanged worker, tested tree and source preimages",
  () =>
    fixture((root) =>
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
        yield* io(() => fs.writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n"));
        const { prepared, integration: request } = yield* prepareIntegration(handle);
        yield* io(() =>
          fs.writeFile(path.join(prepared.cwd, "other.txt"), "test rewrote source\n"),
        );
        expect(yield* fails(service.integrate(request))).toBe(true);
        yield* io(() => fs.writeFile(path.join(prepared.cwd, "other.txt"), "other\n"));
        yield* io(() => fs.writeFile(path.join(handle.cwd, "other.txt"), "late worker\n"));
        expect(yield* fails(service.integrate(request))).toBe(true);
        yield* io(() => fs.writeFile(path.join(handle.cwd, "other.txt"), "other\n"));
        yield* io(() => fs.writeFile(path.join(root, "other.txt"), "late parent\n"));
        expect(yield* fails(service.integrate(request))).toBe(true);
        expect(yield* readText(root, "src/main.ts")).toBe("baseline\n");
        expect(yield* readText(root, "other.txt")).toBe("late parent\n");
      }),
    ),
  60_000,
);

it.live(
  "forks the original baseline, invalidates revisions and retains recovery metadata",
  () =>
    fixture((root, agent) =>
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
        yield* io(() => fs.writeFile(path.join(handle.cwd, "src/main.ts"), "failed attempt\n"));
        const revision = yield* service.freeze(target(handle));
        const fork = yield* service.fork(target(handle));
        expect(yield* readText(fork.cwd, "src/main.ts")).toBe("baseline\n");
        expect(yield* readText(handle.cwd, "src/main.ts")).toBe("failed attempt\n");
        yield* service.revise({ ...target(handle), revisionId: revision.revisionId });
        expect(
          yield* fails(service.prepare({ ...target(handle), revisionId: revision.revisionId })),
        ).toBe(true);
        expect(yield* fails(service.inspect({ ...target(handle), ownerId: "sibling" }))).toBe(true);
        yield* Effect.gen(function* () {
          const recovered = yield* WorkspaceService;
          expect((yield* recovered.listAll()).records.length).toBe(2);
          expect(yield* fails(recovered.freeze(target(handle)))).toBe(true);
          yield* recovered.recoverDiscard({ ...target(handle), recoveryRiskAccepted: true });
        }).pipe(Effect.provide(WorkspaceService.layer({ agentDirectory: agent })));
        expect(yield* exists(handle.cwd)).toBe(false);
        expect(yield* exists(fork.cwd)).toBe(true);
      }),
    ),
  60_000,
);

it.live(
  "rejects source symlinks, hardlinks and sensitive literals before copying",
  () =>
    fixture((root) =>
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        yield* io(() => fs.symlink("main.ts", path.join(root, "src/link.ts")));
        expect(yield* fails(service.create({ sourceCwd: root, ownerId: "parent" }))).toBe(true);
        yield* io(() => fs.unlink(path.join(root, "src/link.ts")));
        yield* io(() => fs.link(path.join(root, "src/main.ts"), path.join(root, "src/link.ts")));
        expect(yield* fails(service.create({ sourceCwd: root, ownerId: "parent" }))).toBe(true);
        yield* io(() => fs.unlink(path.join(root, "src/link.ts")));
        yield* io(() =>
          fs.writeFile(
            path.join(root, "src/main.ts"),
            `const apiKey = "${"ghp_" + "A".repeat(36)}";\n`,
          ),
        );
        expect(yield* fails(service.create({ sourceCwd: root, ownerId: "parent" }))).toBe(true);
        expect(yield* service.listAll()).toEqual({ records: [], unavailable: [] });
      }),
    ),
  60_000,
);

it.live(
  "rejects non-UTF8 text before snapshot and keeps parent bytes/index exact",
  () =>
    fixture((root) =>
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        const bytes = Buffer.from([99, 97, 102, 233, 10]);
        yield* io(() => fs.writeFile(path.join(root, "src/main.ts"), bytes));
        const index = yield* io(() => fs.readFile(path.join(root, ".git/index")));
        expect(yield* fails(service.create({ sourceCwd: root, ownerId: "parent" }))).toBe(true);
        expect(yield* service.listAll()).toEqual({ records: [], unavailable: [] });
        expect(yield* io(() => fs.readFile(path.join(root, "src/main.ts")))).toEqual(bytes);
        expect(yield* io(() => fs.readFile(path.join(root, ".git/index")))).toEqual(index);
      }),
    ),
  60_000,
);

it.live(
  "captures removed tracked directories as deletions and starts read-only without storage",
  () =>
    fixture((root, agent) =>
      Effect.gen(function* () {
        const service = yield* WorkspaceService;
        expect(yield* service.listAll()).toEqual({ records: [], unavailable: [] });
        expect(yield* exists(path.join(agent, "git-workspaces"))).toBe(false);
        yield* io(() => fs.rm(path.join(root, "src"), { recursive: true }));
        const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
        expect(yield* exists(path.join(handle.cwd, "src"))).toBe(false);
        expect((yield* service.inspect(target(handle))).excludedPaths).toContain(".env");
      }),
    ),
  60_000,
);
