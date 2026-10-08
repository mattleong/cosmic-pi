import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import { acquireNativeLock, CrossProcessLock } from "../src/platform/cross-process-lock.ts";
import {
  nodeFsPromises as fs,
  nodePath as path,
  nodeLockFs,
} from "../src/platform/node-builtins.ts";
import { killChild, spawnIpcChild, temporaryDirectory } from "../src/testing/ipc-child.ts";

// Child processes load TypeScript through Jiti; on a loaded CI runner their startup alone can
// exceed Vitest's 5 s default. Each wait below stays bounded by `spawn`'s own timeout.
vi.setConfig({ testTimeout: 30_000 });

const root = temporaryDirectory("cosmic-lock-test-");
const childScript = fileURLToPath(
  new URL("./fixtures/cross-process-lock-child.ts", import.meta.url),
);
const spawn = (directory: string, mode: string) =>
  spawnIpcChild(childScript, [directory, mode], { timeout: "10 seconds" });

const tryAcquire = (directory: string) =>
  CrossProcessLock.use((lock) => lock.tryAcquire("fixture")).pipe(
    Effect.provide(CrossProcessLock.layer({ directory })),
  );

it.live("excludes a real process, then admits its polling successor after release", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const first = yield* spawn(directory, "hold");
    yield* first.wait("acquired");
    const second = yield* spawn(directory, "once");
    yield* second.wait("attempting");
    expect(yield* tryAcquire(directory)).toBeUndefined();
    yield* Effect.sleep(100);
    expect(second.messages).not.toContain("acquired");
    first.child.send?.("release");
    yield* second.wait("finished");
    const lease = yield* tryAcquire(directory);
    expect(acquireNativeLock("fixture", { directory })).toBeUndefined();
    lease?.release();
    expect(nodeLockFs.readdirSync(directory)).toEqual([]);
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
    const failure = yield* Effect.flip(tryAcquire(directory));
    expect(failure).toMatchObject({ reason: "recovery-required" });
    // The error names the slot to recover: the directory holding the dead owner's evidence.
    expect(failure.slot?.startsWith(directory)).toBe(true);
    const evidence = yield* Effect.promise(() =>
      fs.readFile(path.join(failure.slot ?? "", "owner.json"), "utf8"),
    );
    expect(evidence).toContain("native-pending");
    const second = yield* spawn(directory, "once");
    yield* second.wait("recovery-required");
    expect(second.messages).not.toContain("acquired");
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

it.live("rejects unsafe private-directory permissions without repairing them", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    yield* Effect.tryPromise(() => fs.chmod(directory, 0o755));
    expect(() => acquireNativeLock("unsafe", { directory })).toThrow();
  }).pipe(Effect.scoped),
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
