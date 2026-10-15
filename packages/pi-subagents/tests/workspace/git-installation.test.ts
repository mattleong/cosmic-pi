import { afterAll, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as os from "node:os";
import {
  gitVersionSupported,
  resolveGitInstallation,
} from "../../src/boundary/git-installation.ts";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import { exists, temporaryDirectory, workspaceTests, writeFile } from "./fixtures/repository.ts";

// Isolated Git resolves the user's excludes file once per process from this environment, so it
// must be in place before the first Git call in this file.
const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-home-")));
await fs.mkdir(path.join(home, ".config", "git"), { recursive: true });
await fs.writeFile(path.join(home, ".config", "git", "ignore"), "**/local-notes.md\n");
const inherited = { ...process.env };
vi.stubEnv("HOME", home);
vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
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
});

const test = workspaceTests([["src/main.ts", "baseline\n"]]);

test("leaves out files the user's global excludes file ignores", function* (service, root) {
  yield* writeFile(path.join(root, "notes.md"), "shared notes\n");
  yield* writeFile(path.join(root, "local-notes.md"), "private notes\n");
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  expect(yield* exists(path.join(handle.cwd, "notes.md"))).toBe(true);
  expect(yield* exists(path.join(handle.cwd, "local-notes.md"))).toBe(false);
});
