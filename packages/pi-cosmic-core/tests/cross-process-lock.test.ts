import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import {
  acquireNativeLock,
  CrossProcessLock,
  crossProcessLockHolder,
} from "../src/platform/cross-process-lock.ts";
import {
  nodeFsPromises as fs,
  nodePath as path,
  nodeLockFs,
} from "../src/platform/node-builtins.ts";
import { killChild, spawnIpcChild, temporaryDirectory } from "../src/testing/ipc-child.ts";
import { reusedProcessIdentity } from "../src/testing/process.ts";

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

it.live("does not equate owner death with native service settlement", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const first = yield* spawn(directory, "pending");
    yield* first.wait("acquired");
    yield* killChild(first.child);
    const failure = yield* Effect.flip(tryAcquire(directory));
    expect(failure).toMatchObject({ reason: "recovery-required" });
    expect(
      Option.getOrUndefined(
        Option.map(Option.fromUndefinedOr(failure.slot), Str.startsWith(directory)),
      ),
    ).toBe(true);
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
        if (!paused && Fn.pipe(String(to), Str.includes(".retired-"))) {
          paused = true;
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

it.live("reclaims a lease whose live PID now belongs to a different process", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const lease = acquireNativeLock("fixture", { directory });
    expect(lease).toBeDefined();
    expect(acquireNativeLock("fixture", { directory })).toBeUndefined();
    const [slot] = nodeLockFs.readdirSync(directory);
    const ownerPath = path.join(directory, slot ?? "", "owner.json");
    const owner = yield* Effect.promise(() => fs.readFile(ownerPath, "utf8"));
    expect(owner).toContain('"started"');
    nodeLockFs.writeFileSync(
      ownerPath,
      Fn.pipe(
        owner,
        Str.replace(/"started":"[^"]*"/u, `"started":"${reusedProcessIdentity().started ?? ""}"`),
      ),
    );
    expect(acquireNativeLock("fixture", { directory }, true)).toBeDefined();
  }).pipe(Effect.scoped),
);

interface Entry {
  readonly name: string;
  readonly mode: number;
  readonly children?: ReadonlyArray<Entry>;
}

// Tokens differ between owners, so the layout names each `-<token>` suffix generically.
const layout = (directory: string): ReadonlyArray<Entry> =>
  Arr.map(Arr.sort(nodeLockFs.readdirSync(directory), Str.Order), (name) => {
    const entry = path.join(directory, name);
    const stat = nodeLockFs.lstatSync(entry);
    return {
      name: Fn.pipe(name, Str.replace(/-[a-f0-9]{64}$/u, "-<token>")),
      mode: stat.mode & 0o777,
      ...(stat.isDirectory() && { children: layout(entry) }),
    };
  });

const ownerRecord = (directory: string) => {
  const holder = crossProcessLockHolder("fixture", { directory });
  expect(holder.ownerPid).toBe(process.pid);
  return Fn.pipe(
    nodeLockFs.readFileSync(path.join(holder.slot, "owner.json"), "utf8"),
    Str.replace(/"token":"[a-f0-9]{64}"/u, '"token":"<token>"'),
  );
};

it.live("acquires off the event loop with the same owner record and slots as inline", () =>
  Effect.gen(function* () {
    const offThreadRoot = yield* root;
    const inlineRoot = yield* root;
    const offThread = yield* tryAcquire(offThreadRoot);
    const inline = acquireNativeLock("fixture", { directory: inlineRoot }, true);
    expect(offThread).toBeDefined();
    expect(inline).toBeDefined();
    expect(layout(offThreadRoot)).toEqual(layout(inlineRoot));
    expect(ownerRecord(offThreadRoot)).toEqual(ownerRecord(inlineRoot));
    expect(yield* tryAcquire(inlineRoot)).toBeUndefined();
    expect(acquireNativeLock("fixture", { directory: offThreadRoot }, true)).toBeUndefined();
    offThread?.mutationStarted();
    inline?.mutationStarted();
    expect(ownerRecord(offThreadRoot)).toEqual(ownerRecord(inlineRoot));
    offThread?.mutationSettled();
    inline?.mutationSettled();
    offThread?.release();
    inline?.release();
    expect(nodeLockFs.readdirSync(offThreadRoot)).toEqual([]);
    expect(nodeLockFs.readdirSync(inlineRoot)).toEqual([]);
  }).pipe(Effect.scoped),
);

const injectedFsyncFailure = () =>
  Object.assign(new Error("Injected fsync failure"), { code: "EIO" });

/** Fails the `failing`th fsync of either driver and records descriptors left open. */
const faultyFilesystem = (failing: number) => {
  const { openSync, closeSync, fsync, fsyncSync } = nodeLockFs;
  const open = new Set<number>();
  let flushes = 0;
  const spies = [
    vi.spyOn(nodeLockFs, "openSync").mockImplementation((file, flags, mode) => {
      const fd = openSync(file, flags, mode);
      open.add(fd);
      return fd;
    }),
    vi.spyOn(nodeLockFs, "closeSync").mockImplementation((fd) => {
      open.delete(fd);
      closeSync(fd);
    }),
    vi.spyOn(nodeLockFs, "fsync").mockImplementation((fd, callback) => {
      if (++flushes === failing) setImmediate(() => callback(injectedFsyncFailure()));
      else fsync(fd, callback);
    }),
    vi.spyOn(nodeLockFs, "fsyncSync").mockImplementation((fd) => {
      if (++flushes === failing) throw injectedFsyncFailure();
      fsyncSync(fd);
    }),
  ];
  return Effect.acquireRelease(Effect.succeed(open), () =>
    Effect.sync(() => Arr.forEach(spies, (spy) => spy.mockRestore())),
  );
};

// A fresh acquisition flushes the candidate's owner record, the candidate, then the lock root.
for (const failing of [1, 2, 3])
  it.live(`a failed fsync ${failing} of acquisition closes descriptors and holds no slot`, () =>
    Effect.gen(function* () {
      const offThreadRoot = yield* root;
      const inlineRoot = yield* root;
      const offThreadOpen = yield* Effect.scoped(
        Effect.gen(function* () {
          const open = yield* faultyFilesystem(failing);
          expect(yield* Effect.flip(tryAcquire(offThreadRoot))).toMatchObject({
            reason: "unavailable",
          });
          return [...open];
        }),
      );
      const inlineOpen = yield* Effect.scoped(
        Effect.gen(function* () {
          const open = yield* faultyFilesystem(failing);
          expect(() => acquireNativeLock("fixture", { directory: inlineRoot }, true)).toThrow(
            "Injected fsync failure",
          );
          return [...open];
        }),
      );
      expect(offThreadOpen).toEqual([]);
      expect(inlineOpen).toEqual([]);
      const failed = layout(offThreadRoot);
      expect(failed).toEqual(layout(inlineRoot));
      const next = yield* tryAcquire(offThreadRoot);
      expect(next).toBeDefined();
      next?.release();
      expect(layout(offThreadRoot)).toEqual(failed);
    }).pipe(Effect.scoped),
  );
