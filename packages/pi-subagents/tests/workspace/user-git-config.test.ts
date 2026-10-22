import { afterAll, expect } from "@effect/vitest";
import { vi } from "vitest";
import * as os from "node:os";
import { nodeFsPromises as fs, nodePath as path } from "../support/node-builtins.ts";
import { exists, workspaceTests, writeFile } from "./fixtures/repository.ts";

// Workspace Git runs with the user's global configuration, so its excludes file decides which
// untracked files a baseline carries.
const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-home-")));
await fs.mkdir(path.join(home, ".config", "git"), { recursive: true });
await fs.writeFile(path.join(home, ".gitconfig"), "[core]\n\texcludesFile = .private-ignore\n");
vi.stubEnv("HOME", home);
vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(home, ".gitconfig"));
vi.stubEnv("XDG_CONFIG_HOME", undefined);
afterAll(() => fs.rm(home, { recursive: true, force: true }));

const test = workspaceTests([["src/main.ts", "baseline\n"]]);

test("leaves out files the user's global excludes file ignores", function* (service, root) {
  yield* writeFile(path.join(root, "notes.md"), "shared notes\n");
  yield* writeFile(path.join(root, "local-notes.md"), "private notes\n");
  yield* writeFile(path.join(root, ".private-ignore"), "**/local-notes.md\n");
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  expect(yield* exists(path.join(handle.cwd, "notes.md"))).toBe(true);
  expect(yield* exists(path.join(handle.cwd, "local-notes.md"))).toBe(false);
});
