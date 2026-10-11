import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
  CrossProcessLockError,
  type CrossProcessLease,
  type CrossProcessLockContract,
} from "pi-cosmic-core";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import { makeWriterLease, WriterLeaseService } from "../src/boundary/writer-lease.ts";
import { nodeFsPromises as fs, nodePath } from "./support/node-builtins.ts";

type LockOutcome = "live" | "recovery-required" | "unavailable";

const RECOVERY_SLOT = "/agent/subagents/writer-leases-v3/slot";

const fakeLock = (outcomes: Array<LockOutcome> = []) => {
  const calls: Array<keyof CrossProcessLease | "tryAcquire"> = [];
  const failing = new Set<keyof CrossProcessLease>();
  let held = false;
  const call = (name: keyof CrossProcessLease) => {
    calls.push(name);
    if (failing.has(name)) throw new Error(`${name} failed`);
  };
  const handle: CrossProcessLease = {
    mutationStarted: () => call("mutationStarted"),
    mutationSettled: () => call("mutationSettled"),
    release: () => {
      call("release");
      held = false;
    },
  };
  const lock: CrossProcessLockContract = {
    tryAcquire: () =>
      Effect.suspend(() => {
        calls.push("tryAcquire");
        const outcome = outcomes.shift();
        if (outcome === "recovery-required")
          return Effect.fail(new CrossProcessLockError({ reason: outcome, slot: RECOVERY_SLOT }));
        if (outcome !== undefined && outcome !== "live")
          return Effect.fail(new CrossProcessLockError({ reason: outcome }));
        const admitted = outcome === undefined && !held;
        held ||= admitted;
        return Effect.succeed(admitted ? handle : undefined);
      }),
  };
  return { lock, calls, failing, held: () => held };
};

const adapter = (outcomes?: Array<LockOutcome>) =>
  Effect.gen(function* () {
    const agentDirectory = yield* temporaryDirectory("pi-subagents-writer-lease-");
    const fake = fakeLock(outcomes);
    const service = makeWriterLease(agentDirectory, fake.lock);
    const cwd = yield* service.canonicalize(agentDirectory);
    return {
      ...fake,
      agentDirectory,
      service,
      cwd,
      acquire: service.acquire({ cwd, runId: "run" }),
    };
  });

describe.skipIf(process.platform === "win32")("writer lease adapter", () => {
  it.effect("maps each core admission outcome onto one typed acquire result", () =>
    Effect.gen(function* () {
      const { service, cwd, acquire, calls } = yield* adapter([
        "live",
        "recovery-required",
        "unavailable",
      ]);
      expect(yield* Effect.flip(acquire)).toMatchObject({ reason: "live" });
      const recovery = yield* Effect.flip(acquire);
      expect(recovery).toMatchObject({ reason: "recovery-required" });
      expect(recovery.message).toContain(RECOVERY_SLOT);
      expect(yield* Effect.flip(acquire)).toMatchObject({ _tag: "WriterLeaseAcquireError" });
      yield* acquire;
      expect(calls).toEqual(["tryAcquire", "tryAcquire", "tryAcquire", "tryAcquire"]);
      expect(
        yield* Effect.flip(
          service.acquire({ cwd: { ...cwd, digest: "0".repeat(64) }, runId: "x" }),
        ),
      ).toMatchObject({ _tag: "WriterLeaseAcquireError" });
      expect(calls).toHaveLength(4);
    }).pipe(Effect.scoped),
  );

  it.effect("marks native-pending and settles before releasing any copy of the lease", () =>
    Effect.gen(function* () {
      const { service, acquire, calls, held } = yield* adapter();
      const lease = yield* acquire;
      expect(yield* service.markSpawnStarted(lease)).toBe(lease);
      yield* service.release(lease);
      expect(calls).toEqual(["tryAcquire", "mutationStarted", "mutationSettled", "release"]);
      expect(held()).toBe(false);
      expect(yield* Effect.flip(service.release(lease))).toMatchObject({
        _tag: "WriterLeaseReleaseError",
      });
      expect(yield* Effect.flip(service.markSpawnStarted(lease))).toMatchObject({
        _tag: "WriterLeaseMarkError",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the slot held after a failed mark, settle, or release, even on retry", () =>
    Effect.gen(function* () {
      for (const failure of ["mutationStarted", "mutationSettled", "release"] as const) {
        const { service, acquire, failing, held } = yield* adapter();
        const lease = yield* acquire;
        failing.add(failure);
        const marked = yield* Effect.exit(service.markSpawnStarted(lease));
        expect(Exit.isFailure(marked)).toBe(failure === "mutationStarted");
        expect(yield* Effect.flip(service.release(lease))).toMatchObject({
          _tag: "WriterLeaseReleaseError",
        });
        failing.clear();
        expect(yield* Effect.flip(service.release(lease))).toMatchObject({
          _tag: "WriterLeaseReleaseError",
        });
        expect(held()).toBe(true);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("excludes a live writer across service instances through aliases and renames", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory("pi-subagents-writer-lease-");
      const agentDirectory = nodePath.join(root, "agent");
      const project = nodePath.join(root, "project");
      yield* Effect.promise(() =>
        Promise.all([fs.mkdir(agentDirectory), fs.mkdir(project)]).then(() =>
          fs.symlink(project, nodePath.join(root, "alias"), "dir"),
        ),
      );
      const instance = WriterLeaseService.pipe(
        Effect.provide(WriterLeaseService.layer({ agentDirectory })),
      );
      const first = yield* instance;
      const second = yield* instance;
      const direct = yield* first.canonicalize(project);
      const alias = yield* second.canonicalize(nodePath.join(root, "alias"));
      expect(alias).toEqual(direct);
      const lease = yield* first.acquire({ cwd: direct, runId: "direct" });
      expect(yield* Effect.flip(second.acquire({ cwd: alias, runId: "alias" }))).toMatchObject({
        reason: "live",
      });
      yield* Effect.promise(() => fs.rename(project, nodePath.join(root, "renamed")));
      const renamed = yield* second.canonicalize(nodePath.join(root, "renamed"));
      expect(renamed.digest).toBe(direct.digest);
      expect(yield* Effect.flip(second.acquire({ cwd: renamed, runId: "renamed" }))).toMatchObject({
        reason: "live",
      });
      expect(yield* Effect.flip(second.release(lease))).toMatchObject({
        _tag: "WriterLeaseReleaseError",
      });
      expect(yield* Effect.promise(() => fs.readdir(nodePath.join(root, "renamed")))).toEqual([]);
      yield* first.release(lease);
      yield* second.release(yield* second.acquire({ cwd: renamed, runId: "renamed" }));
    }).pipe(Effect.scoped),
  );

  it.effect("returns a typed canonicalization failure without creating lease state", () =>
    Effect.gen(function* () {
      const { agentDirectory, service } = yield* adapter();
      expect(
        yield* Effect.flip(service.canonicalize(nodePath.join(agentDirectory, "missing"))),
      ).toMatchObject({ _tag: "WriterCwdCanonicalizationError" });
      expect(yield* Effect.promise(() => fs.readdir(agentDirectory))).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
