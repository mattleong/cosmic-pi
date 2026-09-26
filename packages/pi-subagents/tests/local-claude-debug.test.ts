// The opt-in replay ledger is private filesystem state, so these tests exercise
// its real permissions, retention, bounds, and content-safety properties.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  acquireLocalClaudeDebug,
  localClaudeDebugEnabled,
} from "../src/boundary/local-claude-debug.ts";
import { nodeFsPromises as fs, nodePath } from "./support/node-builtins.ts";
import {
  makeTemporaryDirectory,
  removeTemporaryDirectories,
} from "./support/temporary-directories.ts";

const { join } = nodePath;

const setup = () =>
  Effect.promise(() =>
    makeTemporaryDirectory("pi-subagents-claude-debug-").then((directory) => {
      const agentDirectory = join(directory, "agent");
      return fs.mkdir(agentDirectory, { mode: 0o700 }).then(() => ({ agentDirectory }));
    }),
  );

/** Records a bounded tail and reports whether the environment enabled a recorder. */
const recordTail = (
  agentDirectory: string,
  runId: string,
  entries: number,
  environment: NodeJS.ProcessEnv = { PI_SUBAGENTS_CLAUDE_DEBUG: "1" },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const recorder = yield* acquireLocalClaudeDebug({ agentDirectory, environment, runId });
      if (!recorder) return false;
      for (let sequence = 0; sequence < entries; sequence += 1)
        yield* recorder.record({
          kind: "outbound-user",
          sequence,
          operation: sequence % 2 === 0 ? "start" : "steer",
          epoch: 7,
          shouldQuery: true,
        });
      return true;
    }),
  );

afterEach(removeTemporaryDirectories);

describe("local Claude debug ledger", () => {
  it("requires the exact opt-in value", () => {
    expect(localClaudeDebugEnabled({})).toBe(false);
    expect(localClaudeDebugEnabled({ PI_SUBAGENTS_CLAUDE_DEBUG: "true" })).toBe(false);
    expect(localClaudeDebugEnabled({ PI_SUBAGENTS_CLAUDE_DEBUG: "1" })).toBe(true);
  });

  it.effect.each([
    ["creates no state while disabled", {}, "", 1, false],
    ["does not publish an empty ledger", undefined, "", 0, true],
    ["contains persistence failures without changing scope success", undefined, "missing", 1, true],
  ] as const)("%s", ([, environment, subdirectory, entries, acquired]) =>
    Effect.gen(function* () {
      const { agentDirectory } = yield* setup();
      const target = join(agentDirectory, subdirectory);
      expect(yield* recordTail(target, "secret-run", entries, environment)).toBe(acquired);
      expect(yield* Effect.promise(() => fs.readdir(agentDirectory))).toEqual([]);
    }),
  );

  it.effect("writes only a bounded metadata tail with private permissions", () =>
    Effect.gen(function* () {
      const { agentDirectory } = yield* setup();
      const secretRunId = "secret-run-identity";
      yield* recordTail(agentDirectory, secretRunId, 600);

      const root = join(agentDirectory, "subagents", "local-claude-debug-v1");
      const [directoryName] = yield* Effect.promise(() => fs.readdir(root));
      expect(directoryName).toBeDefined();
      if (!directoryName) return;
      const directory = join(root, directoryName);
      const ledger = join(directory, "replay-ledger.ndjson");
      const [rootStat, directoryStat, ledgerStat, content] = yield* Effect.promise(() =>
        Promise.all([
          fs.lstat(root),
          fs.lstat(directory),
          fs.lstat(ledger),
          fs.readFile(ledger, "utf8"),
        ]),
      );

      expect(rootStat.mode & 0o777).toBe(0o700);
      expect(directoryStat.mode & 0o777).toBe(0o700);
      expect(ledgerStat.mode & 0o777).toBe(0o600);
      expect(ledgerStat.size).toBeLessThanOrEqual(64 * 1024);
      expect(content).not.toContain(secretRunId);
      expect(content).not.toContain(agentDirectory);
      const lines: unknown[] = content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toHaveLength(513);
      expect(lines[0]).toMatchObject({ kind: "ledger", dropped: 88 });
      expect(lines.at(-1)).toMatchObject({ kind: "outbound-user", sequence: 599 });
    }),
  );

  it.effect("prunes incomplete package-owned directories within the retention bound", () =>
    Effect.gen(function* () {
      const { agentDirectory } = yield* setup();
      const root = join(agentDirectory, "subagents", "local-claude-debug-v1");
      yield* Effect.promise(() => fs.mkdir(root, { recursive: true, mode: 0o700 }));
      for (let index = 0; index < 9; index += 1)
        yield* Effect.promise(() =>
          fs.mkdir(join(root, `claude-orphan-${index}`), { mode: 0o700 }),
        );

      yield* recordTail(agentDirectory, "replacement-run", 1);
      const entries = yield* Effect.promise(() => fs.readdir(root));
      expect(entries).toHaveLength(8);
      const ledgers = yield* Effect.promise(() =>
        Promise.all(
          entries.map((entry) =>
            fs
              .lstat(join(root, entry, "replay-ledger.ndjson"))
              .then((stat) => stat.isFile())
              .catch(() => false),
          ),
        ),
      );
      expect(ledgers.filter(Boolean)).toHaveLength(1);
    }),
  );

  it.effect("retains at most eight completed ledgers", () =>
    Effect.gen(function* () {
      const { agentDirectory } = yield* setup();
      for (let index = 0; index < 10; index += 1)
        yield* recordTail(agentDirectory, `run-${index}`, 1);
      const root = join(agentDirectory, "subagents", "local-claude-debug-v1");
      const entries = yield* Effect.promise(() => fs.readdir(root));
      expect(entries).toHaveLength(8);
    }),
  );
});
