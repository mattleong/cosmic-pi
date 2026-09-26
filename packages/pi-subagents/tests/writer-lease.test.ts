// Adapter policy runs over a fake core lock; exclusion runs over the real private lock root.
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

const { join } = nodePath;

type LockOutcome = "live" | "recovery-required" | "unavailable";

/** One fake core slot that records handle calls; `failing` makes a call throw. */
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
    withLock: () => Effect.die("unused"),
    tryAcquire: () =>
      Effect.suspend(() => {
        calls.push("tryAcquire");
        const outcome = outcomes.shift();
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
      expect(yield* Effect.flip(acquire)).toMatchObject({ reason: "recovery-required" });
      expect(yield* Effect.flip(acquire)).toMatchObject({ _tag: "WriterLeaseAcquireError" });
      // Core's single call already retries after retiring a dead owner; the adapter never retries.
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

  it.effect("fails closed on a leftover protocol-v2 slot until it is removed", () =>
    Effect.gen(function* () {
      const { agentDirectory, service, cwd, acquire, calls } = yield* adapter();
      const legacy = join(agentDirectory, "subagents", "writer-leases-v2", `${cwd.digest}.lease`);
      yield* Effect.promise(() => fs.mkdir(legacy, { recursive: true }));
      const conflict = yield* Effect.flip(acquire);
      expect(conflict).toMatchObject({ reason: "recovery-required" });
      expect(conflict.message).toContain(legacy);
      expect(calls).toEqual([]);
      yield* Effect.promise(() => fs.rm(legacy, { recursive: true }));
      yield* service.release(yield* acquire);
    }).pipe(Effect.scoped),
  );

  it.effect("excludes a live writer across service instances through aliases and renames", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory("pi-subagents-writer-lease-");
      const agentDirectory = join(root, "agent");
      const project = join(root, "project");
      yield* Effect.promise(() =>
        Promise.all([fs.mkdir(agentDirectory), fs.mkdir(project)]).then(() =>
          fs.symlink(project, join(root, "alias"), "dir"),
        ),
      );
      const instance = WriterLeaseService.pipe(
        Effect.provide(WriterLeaseService.layer({ agentDirectory })),
      );
      const first = yield* instance;
      const second = yield* instance;
      const direct = yield* first.canonicalize(project);
      const alias = yield* second.canonicalize(join(root, "alias"));
      expect(alias).toEqual(direct);
      const lease = yield* first.acquire({ cwd: direct, runId: "direct" });
      expect(yield* Effect.flip(second.acquire({ cwd: alias, runId: "alias" }))).toMatchObject({
        reason: "live",
      });
      yield* Effect.promise(() => fs.rename(project, join(root, "renamed")));
      const renamed = yield* second.canonicalize(join(root, "renamed"));
      expect(renamed.digest).toBe(direct.digest);
      expect(yield* Effect.flip(second.acquire({ cwd: renamed, runId: "renamed" }))).toMatchObject({
        reason: "live",
      });
      expect(yield* Effect.flip(second.release(lease))).toMatchObject({
        _tag: "WriterLeaseReleaseError",
      });
      expect(yield* Effect.promise(() => fs.readdir(join(root, "renamed")))).toEqual([]);
      yield* first.release(lease);
      yield* second.release(yield* second.acquire({ cwd: renamed, runId: "renamed" }));
    }).pipe(Effect.scoped),
  );

  it.effect("returns a typed canonicalization failure without creating lease state", () =>
    Effect.gen(function* () {
      const { agentDirectory, service } = yield* adapter();
      expect(
        yield* Effect.flip(service.canonicalize(join(agentDirectory, "missing"))),
      ).toMatchObject({ _tag: "WriterCwdCanonicalizationError" });
      expect(yield* Effect.promise(() => fs.readdir(agentDirectory))).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
