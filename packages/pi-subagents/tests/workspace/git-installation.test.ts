import { afterAll, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as os from "node:os";
import { resolveGitInstallation } from "../../src/boundary/git-installation.ts";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import {
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
