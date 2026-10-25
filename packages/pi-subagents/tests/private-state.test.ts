import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { reusedProcessIdentity } from "pi-cosmic-core/testing";
import {
  recordPrivateStateOwner,
  sweepAbandonedPrivateState,
} from "../src/boundary/private-state.ts";
import { nodeFsPromises as fs, nodePath as path, nodeSpawn } from "./support/node-builtins.ts";
import { temporaryDirectory } from "./workspace/fixtures/repository.ts";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Rec from "effect/Record";
import * as Str from "effect/String";

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
          Arr.map(Rec.toEntries(files), ([name, text]) =>
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
const reusedPid = reusedProcessIdentity();

describe("private state sweep", () => {
  it.live("removes state as soon as its owner is gone", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const session = path.join(agent, "subagents", SESSION);
      const reused = path.join(session, "agent-0000000001-0a1b2c3d4e5f");
      const exited = path.join(session, "agent-0000000002-0123456789ab");
      yield* entry(reused, { "session.jsonl": "{}\n", "system-prompt.md": "prompt" }, reusedPid);
      yield* entry(exited, { "session.jsonl": "{}\n" }, { pid: yield* exitedProcessId });

      yield* sweepAbandonedPrivateState(agent);

      expect(yield* exists(reused)).toBe(false);
      expect(yield* exists(exited)).toBe(false);
      expect(yield* exists(session)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.live("keeps state a live process owns, however old", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const run = path.join(agent, "subagents", SESSION, "agent-0000000001-0a1b2c3d4e5f");
      yield* entry(run, { "system-prompt.md": "prompt" });
      yield* Effect.orDie(recordPrivateStateOwner(run));
      yield* age(run, 30);

      yield* sweepAbandonedPrivateState(agent);

      expect(yield* exists(run)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("removes an empty session directory and keeps one a live run still uses", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const root = path.join(agent, "subagents");
      const empty = path.join(root, "019fd976-b551-752b-b00e-000000000001");
      const used = path.join(root, SESSION);
      const run = path.join(used, "agent-0000000001-0a1b2c3d4e5f");
      yield* io(() => fs.mkdir(empty, { recursive: true, mode: 0o700 }));
      yield* entry(run, { "system-prompt.md": "prompt" });
      yield* Effect.orDie(recordPrivateStateOwner(run));

      yield* sweepAbandonedPrivateState(agent);

      expect(yield* exists(empty)).toBe(false);
      expect(yield* exists(run)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("removes state without an owner record only after a week untouched", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const root = path.join(agent, "subagents");
      const fresh = path.join(root, SESSION, "agent-0000000001");
      const stale = path.join(root, SESSION, "agent-0000000002");
      const malformed = path.join(root, SESSION, "agent-0000000004");
      yield* entry(fresh, { "system-prompt.md": "prompt" });
      yield* entry(stale, { "system-prompt.md": "prompt" });
      yield* entry(malformed, { "session.jsonl": "{}\n", "owner.json": "not json" });
      yield* age(stale, 8);
      yield* age(malformed, 8);

      yield* sweepAbandonedPrivateState(agent);

      expect(yield* exists(fresh)).toBe(true);
      expect(yield* exists(stale)).toBe(false);
      expect(yield* exists(malformed)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.live("keeps old state whose live owner recorded an incomparable identity", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const session = path.join(agent, "subagents", SESSION);
      const oldFormat = path.join(session, "agent-0000000001");
      const withoutStart = path.join(session, "agent-0000000002");
      const reused = path.join(session, "agent-0000000003");
      yield* entry(
        oldFormat,
        { "system-prompt.md": "prompt" },
        { pid: process.pid, started: "Sun Oct 18 20:54:19 2026" },
      );
      yield* entry(withoutStart, { "system-prompt.md": "prompt" }, { pid: process.pid });
      yield* entry(reused, { "system-prompt.md": "prompt" }, reusedPid);
      for (const directory of [oldFormat, withoutStart, reused]) yield* age(directory, 30);

      yield* sweepAbandonedPrivateState(agent);

      expect(yield* exists(oldFormat)).toBe(true);
      expect(yield* exists(withoutStart)).toBe(true);
      expect(yield* exists(reused)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.live("leaves reports, leases, and unrelated directories alone", () =>
    Effect.gen(function* () {
      const agent = yield* temporaryAgent;
      const root = path.join(agent, "subagents");
      const kept = [
        path.join(root, "reports", SESSION),
        path.join(root, "writer-leases-v3", Fn.pipe("a", Str.repeat(64))),
        path.join(root, "workflow-runs", "wf-1"),
        path.join(root, SESSION, "notes"),
        path.join(agent, "subagent-worktrees", "workspace-1"),
      ];
      for (const directory of kept) {
        yield* entry(directory, { "file.txt": "kept" }, reusedPid);
        yield* age(directory, 30);
      }

      yield* sweepAbandonedPrivateState(agent);

      for (const directory of kept) expect(yield* exists(directory)).toBe(true);
    }).pipe(Effect.scoped),
  );
});
