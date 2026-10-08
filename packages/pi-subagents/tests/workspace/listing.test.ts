import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { SafeFile, nodeFilePlatformLayer } from "pi-cosmic-core";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import { listWorkspaceRecords } from "../../src/boundary/git-worktree-recovery.ts";
import * as store from "../../src/boundary/git-worktree-store.ts";
import { WorkspaceService } from "../../src/workspace/service.ts";
import {
  WorkspaceError,
  WorkspaceRecordSchema,
  type WorkspaceRecord,
} from "../../src/workspace/model.ts";
import { commitRepository, io, readText, temporaryDirectory } from "./fixtures/repository.ts";

const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(WorkspaceRecordSchema));
const id = (ordinal: number) =>
  `${ordinal.toString(16).padStart(8, "0")}-1111-1111-1111-111111111111`;
const record = (workspaceId: string): WorkspaceRecord => ({
  version: 1,
  handle: {
    workspaceId,
    ownerId: "parent",
    sourceRoot: "/source",
    sourceCwd: "/source",
    cwd: "/private/worker",
  },
  status: "active",
  baseline: "baseline",
});
const fixture = <A, E, R>(test: (root: string, registry: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const root = yield* temporaryDirectory("workspace-listing-");
    const registry = path.join(root, "git-workspaces");
    yield* io(() => fs.mkdir(registry, { mode: 0o700 }));
    return yield* test(root, registry);
  }).pipe(Effect.provide(SafeFile.layer.pipe(Layer.provide(nodeFilePlatformLayer))));
/** Replaces single-record reads for the rest of the test. */
const mockRecordReads = (read: typeof store.readWorkspaceRecord) =>
  Effect.acquireRelease(
    Effect.sync(() => vi.spyOn(store, "readWorkspaceRecord").mockImplementation(read)),
    (spy) => Effect.sync(() => spy.mockRestore()),
  );

it.live(
  "keeps healthy records beside unavailable artifacts without leaking partial metadata or changing files",
  () =>
    fixture((root, registry) =>
      Effect.gen(function* () {
        const healthy = record(id(1));
        yield* io(() => fs.mkdir(path.join(registry, id(1)), { mode: 0o700 }));
        yield* store.saveWorkspaceRecord(registry, healthy);
        const corrupt = [
          undefined,
          '{"ownerId":"secret-owner","sourceCwd":"/secret-source","cwd":"/secret-cwd",',
          '{"handle":{"ownerId":"secret-owner","sourceCwd":"/secret-source"}}',
          yield* encodeRecord(record(id(1))),
          yield* encodeRecord({
            ...record(id(6)),
            handle: { ...record(id(6)).handle, cwd: "/source/worker" },
          }),
        ];
        for (const [index, content] of corrupt.entries()) {
          const directory = path.join(registry, id(index + 2));
          yield* io(() => fs.mkdir(directory, { mode: 0o700 }));
          if (content !== undefined)
            yield* io(() =>
              fs.writeFile(path.join(directory, "record.json"), content, { mode: 0o600 }),
            );
        }
        // Sparse oversize file exercises the reader limit without allocating a huge payload.
        for (const ordinal of [7, 8, 9])
          yield* io(() => fs.mkdir(path.join(registry, id(ordinal)), { mode: 0o700 }));
        const oversized = path.join(registry, id(7), "record.json");
        yield* io(() => fs.writeFile(oversized, "", { mode: 0o600 }));
        yield* io(() => fs.truncate(oversized, 64 * 1024 * 1024 + 1));
        const external = path.join(root, "external");
        yield* io(() => fs.mkdir(external));
        const externalRecord = path.join(external, "record.json");
        const externalBytes = yield* encodeRecord(record(id(8)));
        yield* io(() => fs.writeFile(externalRecord, externalBytes));
        yield* io(() => fs.symlink(externalRecord, path.join(registry, id(8), "record.json")));
        yield* io(() => fs.mkdir(path.join(registry, id(9), "record.json")));
        yield* io(() => fs.symlink(external, path.join(registry, id(10))));
        yield* io(() => fs.writeFile(path.join(registry, id(11)), "not a directory"));
        const before = yield* io(() => fs.readdir(registry));
        const listing = yield* listWorkspaceRecords(registry);
        expect(listing.records).toEqual([healthy]);
        expect(listing.unavailable).toEqual(
          Array.from({ length: 10 }, (_, index) => ({
            workspaceId: id(index + 2),
            status: "unavailable",
            reason: "recovery-record-unavailable",
          })),
        );
        expect(yield* io(() => fs.readdir(registry))).toEqual(before);
        for (const [index, content] of corrupt.entries()) {
          if (content !== undefined)
            expect(yield* readText(registry, id(index + 2), "record.json")).toBe(content);
        }
        expect(yield* readText(externalRecord)).toBe(externalBytes);
        // Single-record reads remain strict; a directory-name diagnostic is never a handle.
        for (const artifact of listing.unavailable) {
          expect(
            yield* store.readWorkspaceRecord(registry, artifact.workspaceId).pipe(Effect.flip),
          ).toMatchObject({ _tag: "WorkspaceError" });
        }
      }),
    ),
);

for (const unsafe of [
  "registry symlink",
  "ancestor symlink",
  "permissions",
  "not directory",
] as const) {
  it.live(`rejects the complete listing for an unsafe registry: ${unsafe}`, () =>
    fixture((root, registry) =>
      Effect.gen(function* () {
        let target = registry;
        if (unsafe === "permissions") yield* io(() => fs.chmod(registry, 0o777));
        else if (unsafe === "ancestor symlink") {
          yield* io(() => fs.symlink(root, path.join(root, "alias")));
          target = path.join(root, "alias", "git-workspaces");
        } else {
          yield* io(() => fs.rename(registry, `${registry}-saved`));
          if (unsafe === "registry symlink")
            yield* io(() => fs.symlink(`${registry}-saved`, registry));
          else yield* io(() => fs.writeFile(registry, "not a directory"));
        }
        expect(yield* listWorkspaceRecords(target).pipe(Effect.flip)).toMatchObject({
          _tag: "WorkspaceError",
        });
      }),
    ),
  );
}

for (const change of ["permissions", "replacement", "missing", "symlink"] as const) {
  it.live(`rejects a registry that changes during record reads: ${change}`, () =>
    fixture((_root, registry) =>
      Effect.gen(function* () {
        yield* io(() => fs.mkdir(path.join(registry, id(1))));
        yield* mockRecordReads(() =>
          Effect.gen(function* () {
            if (change === "permissions") yield* io(() => fs.chmod(registry, 0o777));
            else {
              yield* io(() => fs.rename(registry, `${registry}-saved`));
              if (change === "replacement") yield* io(() => fs.mkdir(registry, { mode: 0o700 }));
              if (change === "symlink") yield* io(() => fs.symlink(`${registry}-saved`, registry));
            }
            return yield* new WorkspaceError({
              operation: "registry",
              message: "Reader discovered a registry failure.",
            });
          }),
        );
        expect(yield* listWorkspaceRecords(registry).pipe(Effect.flip)).toMatchObject({
          _tag: "WorkspaceError",
        });
      }),
    ),
  );
}

for (const failure of ["interruption", "defect"] as const) {
  it.live(`does not turn a reader ${failure} into a diagnostic row`, () =>
    fixture((_root, registry) =>
      Effect.gen(function* () {
        yield* io(() => fs.mkdir(path.join(registry, id(1))));
        yield* mockRecordReads(() =>
          failure === "interruption" ? Effect.interrupt : Effect.die("reader defect"),
        );
        const fiber = yield* listWorkspaceRecords(registry).pipe(Effect.forkChild);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(
            failure === "interruption"
              ? Cause.hasInterruptsOnly(exit.cause)
              : Cause.hasDies(exit.cause),
          ).toBe(true);
      }),
    ),
  );
}

it.live("leaves healthy workspaces operable but never discards an incomplete artifact", () =>
  fixture((root, registry) =>
    Effect.gen(function* () {
      const source = path.join(root, "source");
      yield* commitRepository(source, [["main.ts", "baseline\n"]]);
      yield* Effect.gen(function* () {
        const service = yield* WorkspaceService;
        const handle = yield* service.create({ sourceCwd: source, ownerId: "parent" });
        const incomplete = id(1);
        const artifact = path.join(registry, incomplete);
        yield* io(() => fs.mkdir(artifact, { mode: 0o700 }));
        yield* io(() => fs.writeFile(path.join(artifact, "preserve-me"), "recovery evidence"));
        expect((yield* service.listAll).unavailable).toHaveLength(1);
        expect(yield* service.list({ ownerId: "parent" })).toHaveLength(1);
        yield* io(() => fs.writeFile(path.join(handle.cwd, "main.ts"), "proposal\n"));
        const target = { ...handle, processCleanupConfirmed: true as const };
        const revision = yield* service.freeze(target);
        yield* service.prepare({ ...target, revisionId: revision.revisionId });
        yield* service.discard(target);
        expect((yield* service.inspect(target)).status).toBe("discarded");
        expect(
          yield* service
            .discard({ workspaceId: incomplete, ownerId: "parent", processCleanupConfirmed: true })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "WorkspaceError" });
        expect(yield* io(() => fs.readdir(artifact))).toEqual(["preserve-me"]);
        expect(yield* readText(source, "main.ts")).toBe("baseline\n");
      }).pipe(Effect.provide(WorkspaceService.layer({ agentDirectory: root })));
    }),
  ),
);
