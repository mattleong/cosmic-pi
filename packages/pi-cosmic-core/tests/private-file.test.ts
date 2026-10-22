import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vitest";
import {
  createPrivateDirectory,
  createPrivateFile,
  ensurePrivateDirectory,
  readPrivateFile,
  removeOwnEntry,
  removePrivateDirectory,
  removePrivateTree,
  replacePrivateFile,
} from "../index.ts";
import { nodeFsPromises as fs, nodePath as path } from "../src/platform/node-builtins.ts";
import { deferredPromise, temporaryDirectory } from "../testing.ts";

const root = temporaryDirectory("cosmic-private-file-");
const io = <A>(evaluate: () => Promise<A>) => Effect.promise(evaluate);
const modeOf = (entry: string) =>
  io(() => fs.lstat(entry)).pipe(Effect.map((info) => info.mode & 0o777));
const exists = (entry: string) =>
  io(() =>
    fs.lstat(entry).then(
      () => true,
      () => false,
    ),
  );
const reasonOf = <A>(effect: Effect.Effect<A, { readonly reason: string }>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.reason));

it.live("creates private directories and tightens an existing one of this user", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const created = path.join(directory, "created");
    yield* ensurePrivateDirectory(created);
    expect(yield* modeOf(created)).toBe(0o700);

    const shared = path.join(directory, "shared");
    yield* io(() => fs.mkdir(shared, { mode: 0o755 }));
    yield* io(() => fs.chmod(shared, 0o755));
    yield* ensurePrivateDirectory(shared);
    expect(yield* modeOf(shared)).toBe(0o700);

    expect(yield* reasonOf(createPrivateDirectory(shared))).toBe("exists");
  }),
);

it.live("refuses a link where a private directory belongs and leaves its target alone", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const target = path.join(directory, "target");
    yield* io(() => fs.mkdir(target, { mode: 0o755 }));
    yield* io(() => fs.chmod(target, 0o755));
    const link = path.join(directory, "link");
    yield* io(() => fs.symlink(target, link));

    expect(yield* reasonOf(ensurePrivateDirectory(link))).toBe("unsafe");
    expect(yield* reasonOf(removePrivateDirectory(link))).toBe("unsafe");
    expect(yield* modeOf(target)).toBe(0o755);
    expect(yield* exists(target)).toBe(true);
  }),
);

it.live("creates a private file exclusively and never replaces or follows an existing entry", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const file = path.join(directory, "config.toml");
    yield* createPrivateFile(file, "first");
    expect(yield* modeOf(file)).toBe(0o600);
    expect(yield* readPrivateFile(file, 64)).toBe("first");

    expect(yield* reasonOf(createPrivateFile(file, "second"))).toBe("exists");
    expect(yield* readPrivateFile(file, 64)).toBe("first");

    const outside = path.join(directory, "outside");
    yield* io(() => fs.writeFile(outside, "outside"));
    const link = path.join(directory, "planted");
    yield* io(() => fs.symlink(outside, link));
    expect(yield* reasonOf(createPrivateFile(link, "leak"))).toBe("exists");
    expect(yield* io(() => fs.readFile(outside, "utf8"))).toBe("outside");
  }),
);

it.live("replaces a file by rename and keeps a temporary path someone else holds", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const target = path.join(directory, "record.json");
    const temporary = path.join(directory, "record.json.tmp");
    yield* replacePrivateFile(target, temporary, "one");
    yield* replacePrivateFile(target, temporary, "two");
    expect(yield* readPrivateFile(target, 64)).toBe("two");
    expect(yield* modeOf(target)).toBe(0o600);
    expect(yield* exists(temporary)).toBe(false);

    yield* io(() => fs.writeFile(temporary, "someone else's"));
    expect(yield* reasonOf(replacePrivateFile(target, temporary, "three"))).toBe("exists");
    expect(yield* io(() => fs.readFile(temporary, "utf8"))).toBe("someone else's");
    expect(yield* readPrivateFile(target, 64)).toBe("two");
  }),
);

it.live("removes its own temporary file when the commit fails", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    // Renaming a file over a non-empty directory fails after the temporary file is written.
    const target = path.join(directory, "occupied");
    yield* io(() => fs.mkdir(path.join(target, "child"), { recursive: true }));
    const temporary = path.join(directory, "occupied.tmp");

    expect(yield* reasonOf(replacePrivateFile(target, temporary, "data"))).not.toBe("exists");
    expect(yield* exists(temporary)).toBe(false);
    expect(yield* exists(path.join(target, "child"))).toBe(true);
  }),
);

it.live("an interruption during the rename cannot undo the committed replacement", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const target = path.join(directory, "record.json");
    const temporary = path.join(directory, "record.json.tmp");
    const renaming = deferredPromise();
    const proceed = deferredPromise();
    const rename = fs.rename.bind(fs);
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(fs, "rename").mockImplementation((from, to) => {
          renaming.resolve();
          return proceed.promise.then(() => rename(from, to));
        }),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );

    const writer = yield* Effect.forkChild(replacePrivateFile(target, temporary, "committed"));
    yield* io(() => renaming.promise);
    const interruption = yield* Effect.forkChild(Fiber.interrupt(writer));
    // Without the uninterruptible commit, the interruption would settle here and unlink the
    // temporary file before the rename could publish it.
    yield* Effect.sleep("20 millis");
    expect(interruption.pollUnsafe()).toBeUndefined();
    proceed.resolve();
    yield* Fiber.join(interruption);

    expect(yield* io(() => fs.readFile(target, "utf8"))).toBe("committed");
    expect(yield* exists(temporary)).toBe(false);
  }),
);

it.live("reads only bounded private regular files without following links", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const file = path.join(directory, "owner.json");
    yield* createPrivateFile(file, "owner");
    expect(yield* reasonOf(readPrivateFile(file, 3))).toBe("unsafe");

    yield* io(() => fs.chmod(file, 0o640));
    expect(yield* reasonOf(readPrivateFile(file, 64))).toBe("unsafe");

    const link = path.join(directory, "link.json");
    yield* io(() => fs.symlink(file, link));
    expect(yield* reasonOf(readPrivateFile(link, 64))).toBe("unsafe");
    expect(yield* reasonOf(readPrivateFile(path.join(directory, "absent"), 64))).toBe("missing");
  }),
);

it.live("removes own entries but refuses directories, and treats a missing entry as removed", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const file = path.join(directory, "socket-owner");
    yield* createPrivateFile(file, "");
    yield* removeOwnEntry(file);
    expect(yield* exists(file)).toBe(false);
    yield* removeOwnEntry(file);

    const nested = path.join(directory, "nested");
    yield* io(() => fs.mkdir(nested));
    expect(yield* reasonOf(removeOwnEntry(nested))).toBe("unsafe");
    expect(yield* exists(nested)).toBe(true);
  }),
);

it.live("removes a private tree a process left without owner access", () =>
  Effect.gen(function* () {
    const directory = yield* root;
    const tree = path.join(directory, "harness");
    const locked = path.join(tree, "tmp", "locked");
    yield* io(() => fs.mkdir(locked, { recursive: true, mode: 0o700 }));
    yield* io(() => fs.writeFile(path.join(locked, "file"), "data"));
    yield* io(() => fs.chmod(locked, 0o000));

    yield* removePrivateDirectory(tree);
    expect(yield* exists(tree)).toBe(false);
    yield* removePrivateTree(tree);
    expect(yield* reasonOf(removePrivateDirectory(tree))).toBe("missing");
  }),
);
