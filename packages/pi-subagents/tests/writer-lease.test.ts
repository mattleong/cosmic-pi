import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  CrossProcessLock,
  CrossProcessLockError,
  type CrossProcessLease,
  type CrossProcessLockContract,
} from "pi-cosmic-core";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import { WriterLeaseReleaseError, WriterLeaseService } from "../src/boundary/writer-lease.ts";
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
          return Effect.fail(CrossProcessLockError.make({ reason: outcome, slot: RECOVERY_SLOT }));
        if (outcome !== undefined && outcome !== "live")
          return Effect.fail(CrossProcessLockError.make({ reason: outcome }));
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
    const service = yield* WriterLeaseService.pipe(
      Effect.provide(
        WriterLeaseService.layerWithLock({ agentDirectory }).pipe(
          Layer.provide(Layer.succeed(CrossProcessLock, fake.lock)),
        ),
      ),
    );
    const cwd = yield* service.canonicalize(agentDirectory);
    return {
      ...fake,
      agentDirectory,
      service,
      cwd,
      acquire: service.acquire({ cwd, runId: "run" }),
    };
  });

describe("writer lease adapter", () => {
  it.effect("keeps the slot held after a failed mark, settle, or release, even on retry", () =>
    Effect.gen(function* () {
      for (const failure of ["mutationStarted", "mutationSettled", "release"] as const) {
        const { service, acquire, failing, held } = yield* adapter();
        const lease = yield* acquire;
        failing.add(failure);
        const marked = yield* Effect.exit(service.markSpawnStarted(lease));
        expect(Exit.isFailure(marked)).toBe(failure === "mutationStarted");
        expect(yield* Effect.flip(service.release(lease))).toBeInstanceOf(WriterLeaseReleaseError);
        failing.clear();
        expect(yield* Effect.flip(service.release(lease))).toBeInstanceOf(WriterLeaseReleaseError);
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
      expect(yield* Effect.flip(second.release(lease))).toBeInstanceOf(WriterLeaseReleaseError);
      expect(yield* Effect.promise(() => fs.readdir(nodePath.join(root, "renamed")))).toEqual([]);
      yield* first.release(lease);
      yield* second.release(yield* second.acquire({ cwd: renamed, runId: "renamed" }));
    }).pipe(Effect.scoped),
  );
});
