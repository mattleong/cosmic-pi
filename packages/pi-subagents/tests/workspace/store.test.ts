import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import * as Schema from "effect/Schema";
import { SafeFile, nodeFilePlatformLayer } from "pi-cosmic-core";
import * as Layer from "effect/Layer";
import { readWorkspaceRecord, saveWorkspaceRecord } from "../../src/boundary/git-worktree-store.ts";
import { WorkspaceRecordSchema, type WorkspaceRecord } from "../../src/workspace/model.ts";
import { temporaryDirectory } from "./fixtures/repository.ts";

it.live(
  "bounds encoded records at 64 MiB and preserves the readable record on escaping overflow",
  () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory("workspace-record-");
      const workspaceId = "11111111-1111-1111-1111-111111111111";
      const directory = path.join(root, workspaceId);
      yield* Effect.promise(() => fs.mkdir(directory, { mode: 0o700 }));
      const record: WorkspaceRecord = {
        version: 1,
        handle: {
          workspaceId,
          ownerId: "parent",
          sourceCwd: "/source",
          sourceRoot: "/source",
          cwd: "/private/worker",
        },
        status: "frozen",
        baseline: "baseline",
        revision: { revisionId: "revision", changedPaths: ["deleted.ts"], diff: "" },
      };
      const cap = 64 * 1024 * 1024;
      const overhead = Buffer.byteLength(
        yield* Schema.encodeEffect(Schema.fromJsonString(WorkspaceRecordSchema))(record),
      );
      // Backslashes exercise JSON expansion; the accepted record hits the byte bound exactly.
      const diff =
        "\\".repeat(Math.floor((cap - overhead - 2) / 2)) + "é" + "x".repeat((cap - overhead) % 2);
      yield* saveWorkspaceRecord(root, { ...record, revision: { ...record.revision!, diff } });
      expect((yield* Effect.promise(() => fs.stat(path.join(directory, "record.json")))).size).toBe(
        cap,
      );
      expect((yield* readWorkspaceRecord(root, workspaceId)).revision?.diff.length).toBe(
        diff.length,
      );
      // One extra byte must fail even when the encoded character count still fits.
      expect(
        (yield* saveWorkspaceRecord(root, {
          ...record,
          revision: { ...record.revision!, diff: diff + "x" },
        }).pipe(Effect.flip)).operation,
      ).toBe("registry");
      // A raw 32 MiB deletion diff is permitted, but its encoded record exceeds the cap.
      const failure = yield* saveWorkspaceRecord(root, {
        ...record,
        revision: { ...record.revision!, diff: "\\".repeat(32 * 1024 * 1024) },
      }).pipe(Effect.flip);
      expect(failure.operation).toBe("registry");
      expect((yield* readWorkspaceRecord(root, workspaceId)).revision?.diff.length).toBe(
        diff.length,
      );
      expect(yield* Effect.promise(() => fs.readdir(directory))).toEqual(["record.json"]);
    }).pipe(Effect.provide(SafeFile.layer.pipe(Layer.provide(nodeFilePlatformLayer)))),
  60_000,
);
