import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import {
  acquireLocalClaudeDebug,
  type LocalClaudeDebugEntry,
} from "../src/boundary/local-claude-debug.ts";
import { nodeFsPromises as fs, nodePath } from "./support/node-builtins.ts";

const decodeJsonLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

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
      .map((line) => decodeJsonLine(line));
    return { rootStat, directoryStat, ledgerStat, content, lines };
  });

describe("local Claude debug ledger", () => {
  it.effect.each([
    ["creates no state while disabled", {}, "", 1, false],
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
