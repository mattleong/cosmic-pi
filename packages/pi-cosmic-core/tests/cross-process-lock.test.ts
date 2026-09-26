import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import { CrossProcessLock } from "../src/platform/cross-process-lock.ts";
import { acquireNativeLock } from "../src/platform/cross-process-lock-node.ts";
import {
  nodeFsPromises as fs,
  nodePath as path,
  nodeHomeDirectory,
  nodeLockFs,
} from "../src/platform/node-builtins.ts";
import { killChild, spawnIpcChild, temporaryDirectory } from "../testing.ts";

const root = temporaryDirectory("cosmic-lock-test-");
const childScript = fileURLToPath(
  new URL("./fixtures/cross-process-lock-child.ts", import.meta.url),
);
const spawn = (directory: string, mode: string, home?: string) =>
  spawnIpcChild(childScript, [directory, mode], {
    timeout: "10 seconds",
    env: home === undefined ? undefined : { HOME: home },
  });

it.live("excludes a real process, then admits its successor after release", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const first = yield* spawn(directory, "hold");
    yield* first.wait("acquired");
    const second = yield* spawn(directory, "once");
    yield* second.wait("attempting");
    yield* Effect.sleep(100);
    expect(second.messages).not.toContain("acquired");
    first.child.send?.("release");
    yield* second.wait("finished");
    const names = yield* Effect.tryPromise(() => fs.readdir(directory));
    expect(names).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live("reclaims a positively dead quiescent owner without a timeout lease", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const first = yield* spawn(directory, "hold");
    yield* first.wait("acquired");
    yield* killChild(first.child);
    const second = yield* spawn(directory, "once");
    yield* second.wait("finished");
  }).pipe(Effect.scoped),
);

it.live("does not equate owner death with native service settlement", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const first = yield* spawn(directory, "pending");
    yield* first.wait("acquired");
    yield* killChild(first.child);
    const second = yield* spawn(directory, "once");
    yield* second.wait("recovery-required");
    expect(second.messages).not.toContain("acquired");
  }).pipe(Effect.scoped),
);

const tryAcquire = (directory: string) =>
  CrossProcessLock.use((lock) => lock.tryAcquire("fixture")).pipe(
    Effect.provide(CrossProcessLock.layer({ directory })),
  );

it.live("tryAcquire reports a live owner without waiting, then admits after release", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const first = yield* spawn(directory, "hold");
    yield* first.wait("acquired");
    expect(yield* tryAcquire(directory)).toBeUndefined();
    first.child.send?.("release");
    yield* first.wait("finished");
    const lease = yield* tryAcquire(directory);
    expect(acquireNativeLock("fixture", { directory })).toBeUndefined();
    lease?.release();
    expect(nodeLockFs.readdirSync(directory)).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live("tryAcquire retires a dead quiescent owner and admits in the same call", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const first = yield* spawn(directory, "hold");
    yield* first.wait("acquired");
    yield* killChild(first.child);
    const lease = yield* tryAcquire(directory);
    expect(lease).toBeDefined();
    expect(acquireNativeLock("fixture", { directory })).toBeUndefined();
    lease?.release();
    const next = acquireNativeLock("fixture", { directory });
    expect(next).toBeDefined();
    next?.release();
  }).pipe(Effect.scoped),
);

it.live("tryAcquire fails closed on a dead native-pending owner", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const first = yield* spawn(directory, "pending");
    yield* first.wait("acquired");
    yield* killChild(first.child);
    expect(yield* Effect.flip(tryAcquire(directory))).toMatchObject({
      reason: "recovery-required",
    });
  }).pipe(Effect.scoped),
);

it.live("cancels a lock waiter promptly without releasing another owner", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const owner = acquireNativeLock("wait", { directory })!;
    const pending = yield* CrossProcessLock.use((lock) =>
      lock.withLock("wait", () => Effect.void),
    ).pipe(Effect.provide(CrossProcessLock.layer({ directory, pollMs: 10 })), Effect.forkScoped);
    yield* Effect.sleep(20);
    yield* Fiber.interrupt(pending);
    expect(acquireNativeLock("wait", { directory })).toBeUndefined();
    owner.release();
    const next = acquireNativeLock("wait", { directory })!;
    expect(next).toBeDefined();
    next.release();
  }).pipe(Effect.scoped),
);

it.live("retains an interrupted native owner until its real completion callback", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const owner = acquireNativeLock("native", { directory })!;
    owner.mutationStarted();
    owner.release();
    expect(acquireNativeLock("native", { directory })).toBeUndefined();
    owner.mutationSettled();
    const next = acquireNativeLock("native", { directory })!;
    expect(next).toBeDefined();
    owner.release();
    expect(() => owner.mutationSettled()).toThrow();
    expect(() => owner.mutationStarted()).toThrow();
    expect(acquireNativeLock("native", { directory })).toBeUndefined();
    next.release();
  }).pipe(Effect.scoped),
);

it.live("retires a published owner if acquisition durability confirmation fails", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const original = nodeLockFs.fsyncSync;
    let calls = 0;
    const spy = vi.spyOn(nodeLockFs, "fsyncSync").mockImplementation((fd) => {
      if (++calls === 3) throw Object.assign(new Error("Injected fsync failure"), { code: "EIO" });
      original(fd);
    });
    try {
      expect(() => acquireNativeLock("fault", { directory })).toThrow();
    } finally {
      spy.mockRestore();
    }
    const next = acquireNativeLock("fault", { directory })!;
    expect(next).toBeDefined();
    next.release();
  }).pipe(Effect.scoped),
);

for (const mode of ["death-before-publish", "write-fault"])
  it.live(`does not reserve an empty public slot after ${mode}`, () =>
    Effect.gen(function* () {
      const directory = yield* root;
      const first = yield* spawn(directory, mode);
      yield* first.exited;
      const second = yield* spawn(directory, "once");
      yield* second.wait("finished");
    }).pipe(Effect.scoped),
  );

it.live("derives one account home despite different HOME environments", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    for (const home of [path.join(directory, "first"), path.join(directory, "second")]) {
      const child = yield* spawn(directory, "home", home);
      yield* child.wait("finished");
      expect(child.messages).toContainEqual({ home: nodeHomeDirectory() });
    }
  }).pipe(Effect.scoped),
);

it.live("rejects unsafe private-directory permissions without repairing them", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    yield* Effect.tryPromise(() => fs.chmod(directory, 0o755));
    expect(() => acquireNativeLock("unsafe", { directory })).toThrow();
  }).pipe(Effect.scoped),
);

for (const pending of [false, true])
  it.effect(
    `expires live-owner admission without changing its ${pending ? "pending" : "quiescent"} evidence`,
    () =>
      Effect.gen(function* () {
        const directory = yield* root;
        const owner = acquireNativeLock("deadline", { directory })!;
        if (pending) owner.mutationStarted();
        const before = nodeLockFs.readdirSync(directory);
        const waiter = yield* CrossProcessLock.use((lock) =>
          lock.withLock("deadline", () => Effect.die("Must not admit")),
        ).pipe(
          Effect.provide(CrossProcessLock.layer({ directory, acquireTimeoutMs: 100 })),
          Effect.flip,
          Effect.forkScoped,
        );
        yield* TestClock.adjust(100);
        expect(yield* Fiber.join(waiter)).toMatchObject({ reason: "acquire-timeout" });
        expect(nodeLockFs.readdirSync(directory)).toEqual(before);
        expect(acquireNativeLock("deadline", { directory })).toBeUndefined();
        if (pending) owner.mutationSettled();
        owner.release();
      }),
  );

it.effect("bounds a stalled authority check without publishing a lease", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const waiter = yield* CrossProcessLock.use((lock) =>
      lock.withLock("check", () => Effect.void, Effect.never),
    ).pipe(
      Effect.provide(CrossProcessLock.layer({ directory, acquireTimeoutMs: 100 })),
      Effect.flip,
      Effect.forkScoped,
    );
    yield* TestClock.adjust(100);
    expect(yield* Fiber.join(waiter)).toMatchObject({ reason: "acquire-timeout" });
    expect(nodeLockFs.readdirSync(directory)).toEqual([]);
  }),
);

for (const kind of ["permit", "filesystem"] as const)
  it.effect(`bounds the acquired ${kind} authority check by the inherited admission deadline`, () =>
    Effect.gen(function* () {
      const directory = yield* root;
      const permit = yield* Semaphore.make(1);
      const outer = yield* Semaphore.make(1);
      const withOwnership = (use: () => Effect.Effect<void>, check = Effect.void) =>
        kind === "permit"
          ? CrossProcessLock.withPermit(permit, Effect.suspend(use), check, {
              acquireTimeoutMs: 500,
            })
          : CrossProcessLock.use((lock) => lock.withLock("post-check", use, check)).pipe(
              Effect.provide(CrossProcessLock.layer({ directory, acquireTimeoutMs: 500 })),
            );
      const checking = yield* Deferred.make<void>();
      const lateCheck = yield* Deferred.make<void>();
      let checks = 0;
      let started = false;
      const check = Effect.suspend(() =>
        ++checks === 1
          ? Effect.void
          : Effect.andThen(Deferred.succeed(checking, undefined), Deferred.await(lateCheck)),
      );
      const waiter = yield* CrossProcessLock.withPermit(
        outer,
        withOwnership(() => {
          started = true;
          return Effect.void;
        }, check),
        Effect.sleep(30),
        { acquireTimeoutMs: 100 },
      ).pipe(Effect.flip, Effect.forkScoped);
      // Both outer authority checks spend 30 ms. The inner check has only 40 ms,
      // not its own 500 ms budget, even though it already owns the resource.
      yield* TestClock.adjust(60);
      yield* Deferred.await(checking);
      if (kind === "permit") expect(yield* permit.takeIfAvailable(1)).toBe(false);
      else expect(acquireNativeLock("post-check", { directory })).toBeUndefined();
      yield* TestClock.adjust(40);
      expect(yield* Fiber.join(waiter)).toMatchObject({ reason: "acquire-timeout" });
      expect(started).toBe(false);
      expect(yield* outer.takeIfAvailable(1)).toBe(true);
      yield* outer.release(1);
      if (kind === "filesystem") expect(nodeLockFs.readdirSync(directory)).toEqual([]);

      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const successor = yield* withOwnership(() =>
        Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(finish)),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Deferred.succeed(lateCheck, undefined);
      yield* TestClock.adjust(1_000);
      expect(started).toBe(false);
      // A late check cannot start the expired callback or release its successor.
      // The successor's admitted transaction outlives its own admission deadline.
      if (kind === "permit") expect(yield* permit.takeIfAvailable(1)).toBe(false);
      else expect(acquireNativeLock("post-check", { directory })).toBeUndefined();
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(successor);
      expect(yield* permit.takeIfAvailable(1)).toBe(true);
      yield* permit.release(1);
      expect(nodeLockFs.readdirSync(directory)).toEqual([]);
    }),
  );

it.effect(
  "does not time out admitted work or transfer its ownership at the admission deadline",
  () =>
    Effect.gen(function* () {
      const directory = yield* root;
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const owner = yield* CrossProcessLock.use((lock) =>
        lock.withLock("long", () =>
          Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(finish)),
        ),
      ).pipe(
        Effect.provide(CrossProcessLock.layer({ directory, acquireTimeoutMs: 100 })),
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(10_000);
      expect(acquireNativeLock("long", { directory })).toBeUndefined();
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(owner);
      expect(nodeLockFs.readdirSync(directory)).toEqual([]);
    }),
);

it.effect("shares one budget across nested local permits and filesystem polling", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const incumbent = acquireNativeLock("nested", { directory })!;
    const permit = yield* Semaphore.make(1);
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const local = yield* CrossProcessLock.withPermit(
      permit,
      Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release)),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const waiting = yield* CrossProcessLock.withPermit(
      permit,
      CrossProcessLock.use((lock) => lock.withLock("nested", () => Effect.void)),
      Effect.void,
      { acquireTimeoutMs: 100 },
    ).pipe(Effect.provide(CrossProcessLock.layer({ directory })), Effect.flip, Effect.forkScoped);
    yield* TestClock.adjust(60);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(local);
    yield* TestClock.adjust(40);
    expect(yield* Fiber.join(waiting)).toMatchObject({ reason: "acquire-timeout" });
    expect(yield* permit.takeIfAvailable(1)).toBe(true);
    yield* permit.release(1);
    incumbent.release();
  }),
);

it.live("normal release cycles leave no artifacts and never clean historical evidence", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    for (const name of ["old.retired-token", ".candidate-old", "malformed.released-old"]) {
      nodeLockFs.mkdirSync(path.join(directory, name), { mode: 0o700 });
      nodeLockFs.writeFileSync(path.join(directory, name, "evidence"), "retain", { mode: 0o600 });
    }
    const before = nodeLockFs.readdirSync(directory);
    for (let index = 0; index < 80; index++) {
      const owner = acquireNativeLock("cycles", { directory })!;
      owner.mutationStarted();
      owner.mutationSettled();
      owner.release();
    }
    expect(nodeLockFs.readdirSync(directory)).toEqual(before);
    for (const name of before)
      expect(nodeLockFs.readFileSync(path.join(directory, name, "evidence"), "utf8")).toBe(
        "retain",
      );
  }).pipe(Effect.scoped),
);

it.live(
  "a paused dead reclaimer cannot rename a successor after several normal release cycles",
  () =>
    Effect.gen(function* () {
      const directory = yield* root;
      const deadOwner = yield* spawn(directory, "hold");
      yield* deadOwner.wait("acquired");
      yield* killChild(deadOwner.child);
      const rename = nodeLockFs.renameSync;
      let paused = false;
      let successor: ReturnType<typeof acquireNativeLock>;
      const spy = vi.spyOn(nodeLockFs, "renameSync").mockImplementation((from, to) => {
        if (!paused && String(to).includes(".retired-")) {
          paused = true;
          // The first reclaimer has passed its final token check. A second reclaims
          // that exact dead owner and retains the barrier before successors cycle.
          expect(acquireNativeLock("fixture", { directory })).toBeUndefined();
          for (let index = 0; index < 5; index++)
            acquireNativeLock("fixture", { directory })!.release();
          successor = acquireNativeLock("fixture", { directory });
        }
        return rename(from, to);
      });
      try {
        expect(acquireNativeLock("fixture", { directory })).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
      expect(paused).toBe(true);
      expect(successor).toBeDefined();
      expect(acquireNativeLock("fixture", { directory })).toBeUndefined();
      successor!.mutationStarted();
      successor!.mutationSettled();
      successor!.release();
      const retained = nodeLockFs.readdirSync(directory);
      expect(retained).toHaveLength(1);
      expect(retained[0]).toContain(".retired-");
      expect(nodeLockFs.readdirSync(path.join(directory, retained[0]!))).toEqual(["owner.json"]);
    }).pipe(Effect.scoped),
);

for (const fault of ["renameSync", "fsyncSync", "unlinkSync", "rmdirSync"] as const)
  it.live(
    `retains release evidence after ${fault} failure without a late callback touching successors`,
    () =>
      Effect.gen(function* () {
        const directory = yield* root;
        const owner = acquireNativeLock("release-fault", { directory })!;
        const spy = vi.spyOn(nodeLockFs, fault).mockImplementation(() => {
          throw new Error("Injected release failure");
        });
        try {
          if (fault === "renameSync" || fault === "fsyncSync")
            expect(() => owner.release()).toThrow();
          else owner.release();
        } finally {
          spy.mockRestore();
        }
        const evidence = nodeLockFs.readdirSync(directory);
        expect(evidence).toHaveLength(1);
        if (fault === "renameSync") {
          expect(acquireNativeLock("release-fault", { directory })).toBeUndefined();
          owner.release();
          expect(nodeLockFs.readdirSync(directory)).toEqual(evidence);
          return;
        }
        expect(evidence[0]).toContain(".released-");
        const next = acquireNativeLock("release-fault", { directory })!;
        const before = nodeLockFs.readdirSync(directory);
        owner.release();
        expect(() => owner.mutationSettled()).toThrow();
        expect(() => owner.mutationStarted()).toThrow();
        expect(nodeLockFs.readdirSync(directory)).toEqual(before);
        expect(acquireNativeLock("release-fault", { directory })).toBeUndefined();
        next.release();
        expect(nodeLockFs.readdirSync(directory)).toEqual(evidence);
      }).pipe(Effect.scoped),
  );

it.live("coordinates with a frozen v1 owner and preserves its old-style release tombstone", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const old = yield* spawn(directory, "v1-owner");
    yield* old.wait("acquired");
    expect(acquireNativeLock("fixture", { directory })).toBeUndefined();
    old.child.send?.("release");
    yield* old.wait("finished");
    const historical = nodeLockFs.readdirSync(directory);
    expect(historical).toHaveLength(1);
    for (let index = 0; index < 3; index++) {
      const next = yield* spawn(directory, "once");
      yield* next.wait("finished");
    }
    expect(nodeLockFs.readdirSync(directory)).toEqual(historical);
    expect(nodeLockFs.readdirSync(path.join(directory, historical[0]!))).toEqual(["owner.json"]);
  }).pipe(Effect.scoped),
);

it.live("does not delete unexpected contents even under an owned normal-release name", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const owner = acquireNativeLock("extra", { directory })!;
    const slot = path.join(directory, nodeLockFs.readdirSync(directory)[0]!);
    nodeLockFs.writeFileSync(path.join(slot, "unexpected"), "retain", { mode: 0o600 });
    owner.release();
    const retained = nodeLockFs.readdirSync(directory);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toContain(".released-");
    expect(nodeLockFs.readdirSync(path.join(directory, retained[0]!))).toEqual([
      "owner.json",
      "unexpected",
    ]);
    acquireNativeLock("extra", { directory })!.release();
    expect(nodeLockFs.readdirSync(directory)).toEqual(retained);
  }).pipe(Effect.scoped),
);

for (const afterAdmission of [false, true])
  it.effect(
    `cancels a stalled authority check ${afterAdmission ? "after" : "before"} lease handoff without leaks`,
    () =>
      Effect.gen(function* () {
        const directory = yield* root;
        let checks = 0;
        const admitted = yield* Deferred.make<void>();
        const check = Effect.suspend(() =>
          ++checks === 1 && afterAdmission
            ? Effect.void
            : Effect.andThen(Deferred.succeed(admitted, undefined), Effect.never),
        );
        const waiting = yield* CrossProcessLock.use((lock) =>
          lock.withLock("handoff", () => Effect.void, check),
        ).pipe(Effect.provide(CrossProcessLock.layer({ directory })), Effect.forkScoped);
        yield* Deferred.await(admitted);
        yield* Fiber.interrupt(waiting);
        expect(nodeLockFs.readdirSync(directory)).toEqual([]);
        acquireNativeLock("handoff", { directory })!.release();
      }),
  );

it.effect("rejects invalid admission durations as typed failures without acquiring a permit", () =>
  Effect.gen(function* () {
    const permit = yield* Semaphore.make(1);
    for (const acquireTimeoutMs of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_VALUE,
    ]) {
      expect(
        yield* CrossProcessLock.withPermit(permit, Effect.void, Effect.void, {
          acquireTimeoutMs,
        }).pipe(Effect.flip),
      ).toMatchObject({ reason: "unavailable" });
      expect(yield* permit.takeIfAvailable(1)).toBe(true);
      yield* permit.release(1);
    }
  }),
);
