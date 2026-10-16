import { afterAll, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as os from "node:os";
import {
  gitVersionSupported,
  resolveGitInstallation,
} from "../../src/boundary/git-installation.ts";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import {
  commitRepository,
  exists,
  failureOf,
  temporaryDirectory,
  workspaceTests,
  writeFile,
} from "./fixtures/repository.ts";

// Isolated Git resolves the user's excludes file once per process from this environment, so it
// must be in place before the first Git call in this file.
const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-home-")));
await fs.mkdir(path.join(home, ".config", "git"), { recursive: true });
await fs.writeFile(path.join(home, ".gitconfig"), "[core]\n\texcludesFile = .private-ignore\n");
const inherited = { ...process.env };
vi.stubEnv("HOME", home);
vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(home, ".gitconfig"));
vi.stubEnv("XDG_CONFIG_HOME", undefined);
afterAll(() => fs.rm(home, { recursive: true, force: true }));

describe("Git installation", () => {
  it("requires the oldest Git with every option workspaces use", () => {
    expect(gitVersionSupported("2.31.0")).toBe(true);
    expect(gitVersionSupported("2.34.1")).toBe(true);
    expect(gitVersionSupported("3.0")).toBe(true);
    expect(gitVersionSupported("2.30.9")).toBe(false);
    expect(gitVersionSupported("1.9.5")).toBe(false);
  });

  it.live("finds the user's excludes file the way Git does", () =>
    Effect.gen(function* () {
      const user = yield* temporaryDirectory("pi-git-user-");
      const config = path.join(user, "gitconfig");
      yield* writeFile(config, "[core]\n\texcludesFile = ~/custom-ignore\n");
      const base = { PATH: inherited.PATH, HOME: user };
      const configured = yield* resolveGitInstallation({ ...base, GIT_CONFIG_GLOBAL: config });
      expect(configured.excludesFile).toBe(path.join(user, "custom-ignore"));
      expect(gitVersionSupported(configured.version)).toBe(true);
      const xdg = path.join(user, "xdg");
      expect(
        (yield* resolveGitInstallation({
          ...base,
          GIT_CONFIG_GLOBAL: "/dev/null",
          XDG_CONFIG_HOME: xdg,
        })).excludesFile,
      ).toBe(path.join(xdg, "git", "ignore"));
      expect(
        (yield* resolveGitInstallation({ ...base, GIT_CONFIG_GLOBAL: "/dev/null" })).excludesFile,
      ).toBe(path.join(user, ".config", "git", "ignore"));
    }),
  );

  it.live("refuses an ignore configuration that cannot be safely represented", () =>
    Effect.gen(function* () {
      const user = yield* temporaryDirectory("pi-git-invalid-ignore-");
      const config = path.join(user, "gitconfig");
      yield* writeFile(config, '[core]\n\texcludesFile = "private\\nignore"\n');
      const error = yield* failureOf(
        resolveGitInstallation({ HOME: user, PATH: inherited.PATH, GIT_CONFIG_GLOBAL: config }),
      );
      expect(error.operation).toBe("git");
      expect(error.detail).toBeTruthy();
      yield* writeFile(config, "[core\n");
      expect(
        (yield* failureOf(
          resolveGitInstallation({ HOME: user, PATH: inherited.PATH, GIT_CONFIG_GLOBAL: config }),
        )).operation,
      ).toBe("git");
    }),
  );
});

const test = workspaceTests([["src/main.ts", "baseline\n"]]);

test("leaves out files the user's global excludes file ignores", function* (service, root) {
  yield* writeFile(path.join(root, "notes.md"), "shared notes\n");
  yield* writeFile(path.join(root, "local-notes.md"), "private notes\n");
  yield* writeFile(path.join(root, ".private-ignore"), "**/local-notes.md\n");
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  expect(yield* exists(path.join(handle.cwd, "notes.md"))).toBe(true);
  expect(yield* exists(path.join(handle.cwd, "local-notes.md"))).toBe(false);
});

test("resolves relative global ignores in each source repository, including nested launch cwd", function* (service, root) {
  const other = path.join(path.dirname(root), "other-source");
  yield* commitRepository(other, [["src/main.ts", "other baseline\n"]]);
  for (const directory of [root, other]) {
    yield* writeFile(path.join(directory, "src/private.ts"), "local data\n");
    yield* writeFile(path.join(directory, "src/other-private.ts"), "other local data\n");
  }
  yield* writeFile(path.join(root, ".private-ignore"), "src/private.ts\n");
  yield* writeFile(path.join(other, ".private-ignore"), "src/other-private.ts\n");
  const first = yield* service.create({ sourceCwd: path.join(root, "src"), ownerId: "parent" });
  const second = yield* service.create({ sourceCwd: path.join(other, "src"), ownerId: "parent" });
  expect(yield* exists(path.join(first.cwd, "private.ts"))).toBe(false);
  expect(yield* exists(path.join(first.cwd, "other-private.ts"))).toBe(true);
  expect(yield* exists(path.join(second.cwd, "private.ts"))).toBe(true);
  expect(yield* exists(path.join(second.cwd, "other-private.ts"))).toBe(false);
});
