import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { prepareLocalCliHarness } from "../src/boundary/local-cli-harness.ts";
import {
  recordPrivateStateOwner,
  sweepAbandonedPrivateState,
} from "../src/boundary/private-state.ts";
import { backendLaunch, supervisorMetadata } from "./fixtures/backend-supervisor.ts";
import { nodeFsPromises as fs, nodePath as path, nodeSpawn } from "./support/node-builtins.ts";
import { temporaryDirectory } from "./workspace/fixtures/repository.ts";

const temporaryAgent = temporaryDirectory("private-state-");
const SESSION = "019fd976-b551-752b-b00e-8c8098258305";
const DAY_MILLIS = 24 * 60 * 60 * 1000;

const io = <A>(evaluate: () => Promise<A>) => Effect.promise(evaluate);

const exists = (file: string) =>
  io(() =>
    fs.lstat(file).then(
      () => true,
      () => false,
    ),
  );

/** Creates a directory with files; an owner of `undefined` writes no owner record. */
const entry = (
  directory: string,
  files: Readonly<Record<string, string>>,
  owner?: { readonly pid: number; readonly started?: string },
) =>
  io(() =>
    fs
      .mkdir(directory, { recursive: true, mode: 0o700 })
      .then(() =>
        Promise.all(
          Object.entries(files).map(([name, text]) =>
            fs
              .mkdir(path.dirname(path.join(directory, name)), { recursive: true })
              .then(() => fs.writeFile(path.join(directory, name), text)),
          ),
        ),
      )
      .then(() =>
        owner
          ? fs.writeFile(
              path.join(directory, "owner.json"),
              JSON.stringify({ version: 1, ...owner }),
            )
          : undefined,
      ),
  );

const age = (directory: string, days: number) =>
  Effect.gen(function* () {
    const seconds = ((yield* Clock.currentTimeMillis) - days * DAY_MILLIS) / 1000;
    const names = yield* io(() => fs.readdir(directory));
    for (const name of names)
      yield* io(() => fs.utimes(path.join(directory, name), seconds, seconds));
    yield* io(() => fs.utimes(directory, seconds, seconds));
  });

const exitedProcessId = Effect.callback<number>((resume) => {
  const child = nodeSpawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  child.once("exit", () => resume(Effect.succeed(child.pid ?? 0)));
});

/** This process's PID recorded with another start time: the PID was reused. */
const reusedPid = { pid: process.pid, started: "an earlier process" };

describe("private state sweep", () => {
  it.live("removes state as soon as its owner is gone, copied credentials included", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const root = path.join(agent, "subagents");
      const session = path.join(root, SESSION);
      const run = path.join(session, "agent-r1-1-0a1b2c3d4e5f");
      const harness = path.join(root, "local-cli-v1", "codex-agent-r1-2-0123456789ab");
      const channel = path.join(root, "supervisor-channels-v3", "agent-r1-2-0123456789ab");
      yield* entry(run, { "session.jsonl": "{}\n", "system-prompt.md": "prompt" }, reusedPid);
      yield* entry(
        harness,
        { "codex-home/auth.json": '{"token":"secret"}' },
        { pid: yield* exitedProcessId },
      );
      yield* entry(channel, { "connection.json": "{}" }, reusedPid);

      yield* sweepAbandonedPrivateState(agent);

      expect(yield* exists(run)).toBe(false);
      expect(yield* exists(session)).toBe(false);
      expect(yield* exists(harness)).toBe(false);
      expect(yield* exists(channel)).toBe(false);
      expect(yield* io(() => fs.readdir(path.join(root, "local-cli-v1")))).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("keeps state a live process owns, however old", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const run = path.join(agent, "subagents", SESSION, "agent-r1-1-0a1b2c3d4e5f");
      yield* entry(run, { "system-prompt.md": "prompt" });
      yield* io(() => recordPrivateStateOwner(run));
      yield* age(run, 30);

      yield* sweepAbandonedPrivateState(agent);

      expect(yield* exists(run)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("keeps a prepared local CLI harness while the process that prepared it lives", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const harness = yield* prepareLocalCliHarness(
        { agentDirectory: agent, environment: {} },
        {
          runtime: "claude",
          launch: backendLaunch(),
          supervisor: supervisorMetadata({ stateDirectory: path.join(agent, "supervisor") }),
        },
      );
      yield* age(harness.directory, 30);

      yield* sweepAbandonedPrivateState(agent);

      expect(yield* exists(path.join(harness.directory, "settings.json"))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("removes state without a provable owner only after a week untouched", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const root = path.join(agent, "subagents");
      const fresh = path.join(root, SESSION, "agent-r1-1");
      const stale = path.join(root, SESSION, "agent-r1-2");
      const unknownOwner = path.join(root, SESSION, "agent-r1-3");
      const malformed = path.join(root, "supervisor-channels-v3", "agent-r1-4-0123456789ab");
      yield* entry(fresh, { "system-prompt.md": "prompt" });
      yield* entry(stale, { "system-prompt.md": "prompt" });
      yield* entry(unknownOwner, { "system-prompt.md": "prompt" }, { pid: process.pid });
      yield* entry(malformed, { "connection.json": "{}", "owner.json": "not json" });
      yield* age(stale, 8);
      yield* age(unknownOwner, 8);
      yield* age(malformed, 8);

      yield* sweepAbandonedPrivateState(agent);

      expect(yield* exists(fresh)).toBe(true);
      expect(yield* exists(stale)).toBe(false);
      expect(yield* exists(unknownOwner)).toBe(false);
      expect(yield* exists(malformed)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.live("leaves reports, leases, debug ledgers, and unrelated directories alone", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const root = path.join(agent, "subagents");
      const kept = [
        path.join(root, "reports", SESSION),
        path.join(root, "writer-leases-v3", "a".repeat(64)),
        path.join(root, "local-claude-debug-v1", "claude-0123-4567"),
        path.join(root, "workflow-runs", "wf-1"),
        path.join(root, SESSION, "notes"),
        path.join(agent, "git-workspaces", "workspace-1"),
      ];
      for (const directory of kept) {
        yield* entry(directory, { "file.txt": "kept" }, reusedPid);
        yield* age(directory, 30);
      }

      yield* sweepAbandonedPrivateState(agent);

      for (const directory of kept) expect(yield* exists(directory)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("finishes deletions that an interrupted sweep left behind", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const root = path.join(agent, "subagents");
      const tombstones = [
        path.join(root, SESSION, ".swept-agent-r1-1-0a1b2c"),
        path.join(root, "local-cli-v1", ".swept-claude-agent-r1-2-0a1b2c"),
      ];
      for (const tombstone of tombstones) yield* entry(tombstone, { "settings.json": "{}" });

      yield* sweepAbandonedPrivateState(agent);

      for (const tombstone of tombstones) expect(yield* exists(tombstone)).toBe(false);
      expect(yield* exists(path.join(root, SESSION))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.live("keeps sweeping past an entry it cannot remove", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const root = path.join(agent, "subagents");
      const locked = path.join(root, "local-cli-v1");
      const blocked = path.join(locked, "claude-agent-r1-1-0123456789ab");
      const removable = path.join(root, SESSION, "agent-r1-2");
      yield* entry(blocked, { "settings.json": "{}" }, reusedPid);
      yield* entry(removable, { "system-prompt.md": "prompt" }, reusedPid);
      yield* Effect.acquireRelease(
        io(() => fs.chmod(locked, 0o500)),
        () => io(() => fs.chmod(locked, 0o700)),
      );

      yield* sweepAbandonedPrivateState(agent);

      expect(yield* exists(blocked)).toBe(true);
      expect(yield* exists(removable)).toBe(false);
    }).pipe(Effect.scoped),
  );
});
