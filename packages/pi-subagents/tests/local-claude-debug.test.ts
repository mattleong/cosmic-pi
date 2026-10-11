import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import {
  acquireLocalClaudeDebug,
  type LocalClaudeDebugEntry,
} from "../src/boundary/local-claude-debug.ts";
import { nodeFsPromises as fs, nodePath } from "./support/node-builtins.ts";

const setup = () =>
  temporaryDirectory("pi-subagents-claude-debug-").pipe(
    Effect.map((directory) => nodePath.join(directory, "agent")),
    Effect.tap((agentDirectory) => Effect.promise(() => fs.mkdir(agentDirectory, { mode: 0o700 }))),
  );

const outboundEntry = (sequence: number): LocalClaudeDebugEntry => ({
  kind: "outbound-user",
  sequence,
  operation: sequence % 2 === 0 ? "start" : "steer",
  epoch: 7,
  shouldQuery: true,
});

const recordTail = (
  agentDirectory: string,
  runId: string,
  entries: number,
  environment: NodeJS.ProcessEnv = { PI_SUBAGENTS_CLAUDE_DEBUG: "1" },
  entry = outboundEntry,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const recorder = yield* acquireLocalClaudeDebug({ agentDirectory, environment, runId });
      if (!recorder) return false;
      for (let sequence = 0; sequence < entries; sequence += 1)
        yield* recorder.record(entry(sequence));
      return true;
    }),
  );

const readLedger = (agentDirectory: string) =>
  Effect.gen(function* () {
    const root = nodePath.join(agentDirectory, "subagents", "local-claude-debug-v1");
    const [directoryName = ""] = yield* Effect.promise(() => fs.readdir(root));
    const directory = nodePath.join(root, directoryName);
    const ledger = nodePath.join(directory, "replay-ledger.ndjson");
    const [rootStat, directoryStat, ledgerStat, content] = yield* Effect.promise(() =>
      Promise.all([
        fs.lstat(root),
        fs.lstat(directory),
        fs.lstat(ledger),
        fs.readFile(ledger, "utf8"),
      ]),
    );
    const lines: unknown[] = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return { rootStat, directoryStat, ledgerStat, content, lines };
  });

describe("local Claude debug ledger", () => {
  it.effect.each([
    ["creates no state while disabled", {}, "", 1, false],
    ["requires the exact opt-in value", { PI_SUBAGENTS_CLAUDE_DEBUG: "true" }, "", 1, false],
    ["does not publish an empty ledger", undefined, "", 0, true],
    ["contains persistence failures without changing scope success", undefined, "missing", 1, true],
  ] as const)("%s", ([, environment, subdirectory, entries, acquired]) =>
    Effect.gen(function* () {
      const agentDirectory = yield* setup();
      const target = nodePath.join(agentDirectory, subdirectory);
      expect(yield* recordTail(target, "secret-run", entries, environment)).toBe(acquired);
      expect(yield* Effect.promise(() => fs.readdir(agentDirectory))).toEqual([]);
    }),
  );

  it.effect("writes only a bounded metadata tail with private permissions", () =>
    Effect.gen(function* () {
      const agentDirectory = yield* setup();
      const secretRunId = "secret-run-identity";
      yield* recordTail(agentDirectory, secretRunId, 600);
      const { rootStat, directoryStat, ledgerStat, content, lines } =
        yield* readLedger(agentDirectory);

      expect(rootStat.mode & 0o777).toBe(0o700);
      expect(directoryStat.mode & 0o777).toBe(0o700);
      expect(ledgerStat.mode & 0o777).toBe(0o600);
      expect(ledgerStat.size).toBeLessThanOrEqual(64 * 1024);
      expect(content).not.toContain(secretRunId);
      expect(content).not.toContain(agentDirectory);
      expect(lines).toHaveLength(513);
      expect(lines[0]).toMatchObject({ kind: "ledger", dropped: 88 });
      expect(lines.at(-1)).toMatchObject({ kind: "outbound-user", sequence: 599 });
    }),
  );

  it.effect("counts every entry the byte-bounded tail drops", () =>
    Effect.gen(function* () {
      const agentDirectory = yield* setup();
      yield* recordTail(agentDirectory, "byte-bound", 300, undefined, () => ({
        kind: "user-decision",
        sequence: 777,
        decision: "queued-task-notification",
        epoch: 3,
        replay: true,
        synthetic: false,
        meta: false,
        compact: false,
        session: "match",
        uuid: "known",
        content: "assignment",
        contentForm: "text",
        length: "1-64",
        tag: "none",
        parentTool: false,
        toolResults: false,
        origin: false,
        subkind: false,
        pending: "none",
        report: "none",
      }));
      const { ledgerStat, lines } = yield* readLedger(agentDirectory);
      expect(ledgerStat.size).toBeLessThanOrEqual(64 * 1024);
      expect(lines[0]).toMatchObject({ kind: "ledger", dropped: 300 - (lines.length - 1) });
    }),
  );

  it.effect("prunes incomplete package-owned directories within the retention bound", () =>
    Effect.gen(function* () {
      const agentDirectory = yield* setup();
      const root = nodePath.join(agentDirectory, "subagents", "local-claude-debug-v1");
      yield* Effect.promise(() => fs.mkdir(root, { recursive: true, mode: 0o700 }));
      for (let index = 0; index < 9; index += 1)
        yield* Effect.promise(() =>
          fs.mkdir(nodePath.join(root, `claude-orphan-${index}`), { mode: 0o700 }),
        );

      yield* recordTail(agentDirectory, "replacement-run", 1);
      const entries = yield* Effect.promise(() => fs.readdir(root));
      expect(entries).toHaveLength(8);
      const ledgers = yield* Effect.promise(() =>
        Promise.all(
          entries.map((entry) =>
            fs
              .lstat(nodePath.join(root, entry, "replay-ledger.ndjson"))
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
      const agentDirectory = yield* setup();
      for (let index = 0; index < 10; index += 1)
        yield* recordTail(agentDirectory, `run-${index}`, 1);
      const root = nodePath.join(agentDirectory, "subagents", "local-claude-debug-v1");
      const entries = yield* Effect.promise(() => fs.readdir(root));
      expect(entries).toHaveLength(8);
    }),
  );
});
