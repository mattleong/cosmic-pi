// Live filesystem primitives are exercised at this Node boundary.
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import {
  makeWriterLease,
  writerLeasePath,
  writerLeaseRoot,
  type CanonicalWriterCwd,
} from "../src/boundary/writer-lease.ts";
import {
  nodeFsPromises as fs,
  nodePath,
  nodeSpawn as spawn,
  type NodeChildProcessWithoutNullStreams as ChildProcessWithoutNullStreams,
} from "./support/node-builtins.ts";

const { join } = nodePath;

const token = (character: string): string => character.repeat(64);

const promiseGate = () => {
  const cell = Deferred.makeUnsafe<void>();
  return {
    promise: Effect.runPromise(Deferred.await(cell)),
    open: () => {
      Deferred.doneUnsafe(cell, Effect.void);
    },
  };
};
const childFixturePath = fileURLToPath(
  new URL("./fixtures/writer-lease-child.mjs", import.meta.url),
);

// SAFETY: The test controls the serialized fixture and asserts the exact decoded contract below.
const readOwnerEvidence = (leasePath: string): Promise<{ ownershipToken?: string }> =>
  fs
    .readFile(join(leasePath, "owner.json"), "utf8")
    .then((source) => JSON.parse(source) as { ownershipToken?: string });

interface LeaseChildMessage {
  readonly type: "ready" | "acquired" | "marked" | "released" | "failure" | "exiting";
  readonly runId: string;
  readonly pid?: number | undefined;
  readonly phase?: "reserved" | "spawn-started" | undefined;
  readonly tag?: string | undefined;
  readonly reason?: string | undefined;
  readonly ownerRunId?: string | undefined;
  readonly message?: string | undefined;
}

interface LeaseChild {
  readonly process: ChildProcessWithoutNullStreams;
  readonly send: (command: "acquire" | "mark" | "release" | "exit") => void;
  readonly next: () => Promise<LeaseChildMessage>;
  readonly dispose: () => Promise<void>;
}

const startLeaseChild = (
  agentDirectory: string,
  project: string,
  runId: string,
): Promise<LeaseChild> => {
  const child = spawn(process.execPath, [childFixturePath, agentDirectory, project, runId], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: LeaseChildMessage[] = [];
  const waiters: Array<(message: LeaseChildMessage) => void> = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    // SAFETY: The test controls the serialized fixture and asserts the exact decoded contract below.
    const message = JSON.parse(line) as LeaseChildMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  const next = (): Promise<LeaseChildMessage> => {
    const message = messages.shift();
    if (message) return Promise.resolve(message);
    const cell = Deferred.makeUnsafe<LeaseChildMessage>();
    waiters.push((incoming) => {
      Deferred.doneUnsafe(cell, Effect.succeed(incoming));
    });
    return Effect.runPromise(Deferred.await(cell));
  };
  const dispose = (): Promise<void> => {
    lines.close();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const exited = Deferred.makeUnsafe<void>();
    if (child.exitCode !== null || child.signalCode !== null)
      Deferred.doneUnsafe(exited, Effect.void);
    else child.once("exit", () => Deferred.doneUnsafe(exited, Effect.void));
    return Effect.runPromise(Deferred.await(exited)).then(() => {
      if (stderr) throw new Error(stderr);
    });
  };
  const leaseChild: LeaseChild = {
    process: child,
    send: (command) => child.stdin.write(`${command}\n`),
    next,
    dispose,
  };
  return next().then((ready) => {
    if (ready.type !== "ready")
      return dispose().then(() => {
        throw new Error(`writer-lease child did not become ready: ${JSON.stringify(ready)}`);
      });
    return leaseChild;
  });
};

const withFixture = <A, E>(
  use: (fixture: {
    readonly root: string;
    readonly agentDirectory: string;
    readonly project: string;
  }) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () =>
        fs.mkdtemp(join(tmpdir(), "pi-subagents-writer-lease-")).then((root) => {
          const agentDirectory = join(root, "agent-state");
          const project = join(root, "project");
          return fs
            .mkdir(agentDirectory, { mode: 0o700 })
            .then(() => fs.mkdir(project, { mode: 0o700 }))
            .then(() => ({ root, agentDirectory, project }));
        }),
      catch: () => "fixture setup failed" as const,
    }).pipe(Effect.orDie),
    use,
    ({ root }) =>
      Effect.tryPromise({
        try: () => fs.rm(root, { recursive: true, force: true }),
        catch: () => undefined,
      }).pipe(Effect.orDie),
  );

const acquire = (
  service: ReturnType<typeof makeWriterLease>,
  cwd: CanonicalWriterCwd,
  runId: string,
) => service.acquire({ cwd, sessionId: "parent-session", runId });

describe.skipIf(process.platform === "win32")("cross-process writer leases", () => {
  it.effect("canonical aliases resolve to one hashed private lease slot", () =>
    withFixture(({ root, agentDirectory, project }) =>
      Effect.gen(function* () {
        const alias = join(root, "project-alias");
        yield* Effect.tryPromise({
          try: () => fs.symlink(project, alias, process.platform === "win32" ? "junction" : "dir"),
          catch: () => "fixture symlink failed" as const,
        }).pipe(Effect.orDie);
        const first = makeWriterLease({
          agentDirectory,
          ownerNonce: token("a"),
          randomToken: () => token("1"),
        });
        const second = makeWriterLease({
          agentDirectory,
          ownerNonce: token("b"),
          randomToken: () => token("2"),
        });
        const direct = yield* first.canonicalize(project);
        const throughAlias = yield* second.canonicalize(alias);
        expect(throughAlias).toEqual(direct);

        const lease = yield* acquire(first, direct, "writer-direct");
        const conflict = yield* acquire(second, throughAlias, "writer-alias").pipe(Effect.flip);
        expect(conflict).toMatchObject({
          _tag: "WriterLeaseConflictError",
          reason: "live",
          ownerRunId: "writer-direct",
        });
        expect(lease.leasePath).toBe(writerLeasePath(agentDirectory, direct.digest));
        expect(lease.leasePath).not.toContain(project);
        expect(yield* Effect.tryPromise(() => fs.readdir(project)).pipe(Effect.orDie)).toEqual([]);
        yield* first.release(lease);
      }),
    ),
  );

  it.effect("interrupts a pre-ownership acquisition wait without creating a lease slot", () =>
    withFixture(({ agentDirectory, project }) =>
      Effect.gen(function* () {
        const entered = promiseGate();
        const gate = promiseGate();
        const service = makeWriterLease({
          agentDirectory,
          ownerNonce: token("1"),
          randomToken: () => token("2"),
          beforeAcquireCommit: () => {
            entered.open();
            return gate.promise;
          },
        });
        const cwd = yield* service.canonicalize(project);
        const acquiring = yield* acquire(service, cwd, "pre-ownership-wait").pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Effect.promise(() => entered.promise);
        yield* Fiber.interrupt(acquiring);
        const exists = yield* Effect.promise(() =>
          fs.stat(writerLeasePath(agentDirectory, cwd.digest)).then(
            () => true,
            () => false,
          ),
        );
        expect(exists).toBe(false);
        gate.open();
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("finishes durable evidence when interrupted after exclusive lease creation", () =>
    withFixture(({ agentDirectory, project }) =>
      Effect.gen(function* () {
        const entered = promiseGate();
        const gate = promiseGate();
        const owner = makeWriterLease({
          agentDirectory,
          ownerNonce: token("3"),
          randomToken: () => token("4"),
          afterAcquireDirectoryCreated: () => {
            entered.open();
            return gate.promise;
          },
        });
        const contender = makeWriterLease({
          agentDirectory,
          ownerNonce: token("5"),
          randomToken: () => token("6"),
        });
        const cwd = yield* owner.canonicalize(project);
        const acquiring = yield* acquire(owner, cwd, "commit-owner").pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Effect.promise(() => entered.promise);
        const interrupting = yield* Fiber.interrupt(acquiring).pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        gate.open();
        yield* Fiber.join(interrupting);
        const conflict = yield* acquire(contender, cwd, "after-commit-interrupt").pipe(Effect.flip);
        expect(conflict).toMatchObject({
          _tag: "WriterLeaseConflictError",
          reason: "live",
          ownerRunId: "commit-owner",
        });
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("interrupts release before rename and leaves the exact owner locked", () =>
    withFixture(({ agentDirectory, project }) =>
      Effect.gen(function* () {
        const entered = promiseGate();
        const gate = promiseGate();
        const owner = makeWriterLease({
          agentDirectory,
          ownerNonce: token("7"),
          randomToken: () => token("8"),
          beforeReleaseRename: () => {
            entered.open();
            return gate.promise;
          },
        });
        const cleanup = makeWriterLease({
          agentDirectory,
          ownerNonce: token("9"),
          randomToken: () => token("a"),
        });
        const cwd = yield* owner.canonicalize(project);
        const lease = yield* acquire(owner, cwd, "cleanup-owner");
        const releasing = yield* owner
          .release(lease)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Effect.promise(() => entered.promise);
        yield* Fiber.interrupt(releasing);
        const conflict = yield* acquire(cleanup, cwd, "cleanup-contender").pipe(Effect.flip);
        expect(conflict).toMatchObject({
          _tag: "WriterLeaseConflictError",
          reason: "live",
          ownerRunId: "cleanup-owner",
        });
        gate.open();
        yield* cleanup.release(lease);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("keeps one filesystem identity locked across a directory rename", () =>
    withFixture(({ root, agentDirectory, project }) =>
      Effect.gen(function* () {
        const renamedProject = join(root, "project-renamed");
        const owner = makeWriterLease({
          agentDirectory,
          ownerNonce: token("a"),
          randomToken: () => token("3"),
        });
        const contender = makeWriterLease({
          agentDirectory,
          ownerNonce: token("b"),
          randomToken: () => token("4"),
        });
        const beforeRename = yield* owner.canonicalize(project);
        yield* Effect.tryPromise(() => fs.rename(project, renamedProject)).pipe(Effect.orDie);
        const afterRename = yield* contender.canonicalize(renamedProject);
        expect(afterRename.path).not.toBe(beforeRename.path);
        expect(afterRename.filesystemIdentity).toBe(beforeRename.filesystemIdentity);
        expect(afterRename.digest).toBe(beforeRename.digest);

        const lease = yield* acquire(owner, beforeRename, "rename-owner");
        const conflict = yield* acquire(contender, afterRename, "rename-contender").pipe(
          Effect.flip,
        );
        expect(conflict).toMatchObject({
          _tag: "WriterLeaseConflictError",
          reason: "live",
          ownerRunId: "rename-owner",
        });
        yield* owner.release(lease);
      }),
    ),
  );

  it.effect("conflicts with a live owner held by an isolated service instance", () =>
    withFixture(({ agentDirectory, project }) =>
      Effect.gen(function* () {
        const owner = makeWriterLease({
          agentDirectory,
          ownerNonce: token("a"),
          randomToken: () => token("3"),
        });
        const contender = makeWriterLease({
          agentDirectory,
          ownerNonce: token("b"),
          randomToken: () => token("4"),
        });
        const cwd = yield* owner.canonicalize(project);
        const lease = yield* acquire(owner, cwd, "live-owner");
        const result = yield* acquire(contender, cwd, "contender").pipe(Effect.flip);
        expect(result).toMatchObject({
          _tag: "WriterLeaseConflictError",
          reason: "live",
          ownerPid: process.pid,
          ownerRunId: "live-owner",
        });
        yield* owner.release(lease);
      }),
    ),
  );

  it.effect("takes over only a positively dead owner and retains an ABA tombstone", () =>
    withFixture(({ agentDirectory, project }) =>
      Effect.gen(function* () {
        const deadPid = 2_000_000_001;
        const deadOwner = makeWriterLease({
          agentDirectory,
          parentPid: deadPid,
          ownerNonce: token("a"),
          randomToken: () => token("5"),
        });
        const contender = makeWriterLease({
          agentDirectory,
          ownerNonce: token("b"),
          randomToken: () => token("6"),
          probeOwner: (pid) => (pid === deadPid ? "dead" : "alive"),
        });
        const cwd = yield* deadOwner.canonicalize(project);
        yield* acquire(deadOwner, cwd, "dead-owner");
        const replacement = yield* acquire(contender, cwd, "replacement");
        expect(replacement.evidence.runId).toBe("replacement");
        const entries = yield* Effect.tryPromise(() =>
          fs.readdir(writerLeaseRoot(agentDirectory)),
        ).pipe(Effect.orDie);
        expect(entries.some((entry) => entry.includes(".tombstone-"))).toBe(true);
        yield* contender.release(replacement);
      }),
    ),
  );

  it.effect("never reclaims a dead spawn-started lease while a detached backend survives", () =>
    withFixture(({ agentDirectory, project }) =>
      Effect.acquireUseRelease(
        Effect.try({
          try: () =>
            spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
              stdio: "ignore",
              detached: true,
            }),
          catch: () => "backend fixture spawn failed" as const,
        }).pipe(Effect.orDie),
        (backend) =>
          Effect.gen(function* () {
            const deadPid = 2_000_000_101;
            const deadOwner = makeWriterLease({
              agentDirectory,
              parentPid: deadPid,
              ownerNonce: token("a"),
              randomToken: () => token("7"),
            });
            const contender = makeWriterLease({
              agentDirectory,
              ownerNonce: token("b"),
              randomToken: () => token("8"),
              probeOwner: (pid) => (pid === deadPid ? "dead" : "alive"),
            });
            const cwd = yield* deadOwner.canonicalize(project);
            const reserved = yield* acquire(deadOwner, cwd, "dead-spawn-owner");
            const marked = yield* deadOwner.markSpawnStarted(reserved);
            expect(marked.evidence.phase).toBe("spawn-started");
            expect(backend.pid).toBeDefined();
            expect(() => process.kill(backend.pid!, 0)).not.toThrow();

            const refusal = yield* acquire(contender, cwd, "unsafe-takeover").pipe(Effect.flip);
            expect(refusal).toMatchObject({
              _tag: "WriterLeaseConflictError",
              reason: "spawn-started",
              ownerRunId: "dead-spawn-owner",
            });
            expect(() => process.kill(backend.pid!, 0)).not.toThrow();
            yield* Effect.callback<void>((resume) => {
              backend.once("exit", () => resume(Effect.void));
              backend.kill("SIGKILL");
            });
            expect(() => process.kill(backend.pid!, 0)).toThrow();
            yield* deadOwner.release(marked);
          }),
        (backend) =>
          Effect.sync(() => {
            if (backend.pid) {
              try {
                process.kill(-backend.pid, "SIGKILL");
              } catch {
                backend.kill("SIGKILL");
              }
            }
          }),
      ),
    ),
  );

  it.effect("fails closed on dead transitional evidence instead of reclaiming reservation", () =>
    withFixture(({ agentDirectory, project }) =>
      Effect.gen(function* () {
        const deadPid = 2_000_000_102;
        const deadOwner = makeWriterLease({
          agentDirectory,
          parentPid: deadPid,
          ownerNonce: token("a"),
          randomToken: () => token("c"),
        });
        const contender = makeWriterLease({
          agentDirectory,
          ownerNonce: token("b"),
          randomToken: () => token("d"),
          probeOwner: (pid) => (pid === deadPid ? "dead" : "alive"),
        });
        const cwd = yield* deadOwner.canonicalize(project);
        const reserved = yield* acquire(deadOwner, cwd, "transitional-owner");
        yield* Effect.tryPromise(() =>
          fs.writeFile(join(reserved.leasePath, ".owner.json.spawn-interrupted.tmp"), "partial", {
            mode: 0o600,
          }),
        ).pipe(Effect.orDie);

        const refusal = yield* acquire(contender, cwd, "transitional-contender").pipe(Effect.flip);
        expect(refusal).toMatchObject({
          _tag: "WriterLeaseConflictError",
          reason: "transitional",
        });
        yield* Effect.tryPromise(() =>
          fs.rm(reserved.leasePath, { recursive: true, force: true }),
        ).pipe(Effect.orDie);
      }),
    ),
  );

  it.effect("fails closed for corrupt and liveness-uncertain evidence", () =>
    withFixture(({ agentDirectory, project }) =>
      Effect.gen(function* () {
        const service = makeWriterLease({
          agentDirectory,
          ownerNonce: token("a"),
          randomToken: () => token("7"),
          probeOwner: () => "uncertain",
        });
        const cwd = yield* service.canonicalize(project);
        yield* Effect.tryPromise({
          try: () =>
            fs
              .mkdir(writerLeaseRoot(agentDirectory), { recursive: true, mode: 0o700 })
              .then(() => fs.mkdir(writerLeasePath(agentDirectory, cwd.digest), { mode: 0o700 }))
              .then(() =>
                fs.writeFile(
                  join(writerLeasePath(agentDirectory, cwd.digest), "owner.json"),
                  "{not-json",
                  { mode: 0o600 },
                ),
              ),
          catch: () => "fixture corrupt lease setup failed" as const,
        }).pipe(Effect.orDie);
        const corrupt = yield* acquire(service, cwd, "corrupt-contender").pipe(Effect.flip);
        expect(corrupt).toMatchObject({
          _tag: "WriterLeaseConflictError",
          reason: "corrupt",
        });

        yield* Effect.tryPromise(() =>
          fs.rm(writerLeasePath(agentDirectory, cwd.digest), { recursive: true, force: true }),
        ).pipe(Effect.orDie);
        const uncertainOwner = makeWriterLease({
          agentDirectory,
          parentPid: 45_678,
          ownerNonce: token("b"),
          randomToken: () => token("8"),
        });
        const uncertainLease = yield* acquire(uncertainOwner, cwd, "uncertain-owner");
        const uncertain = yield* acquire(service, cwd, "uncertain-contender").pipe(Effect.flip);
        expect(uncertain).toMatchObject({
          _tag: "WriterLeaseConflictError",
          reason: "uncertain",
          ownerRunId: "uncertain-owner",
        });
        yield* uncertainOwner.release(uncertainLease);
      }),
    ),
  );

  it.effect("does not mark spawn-started when ownership presents the wrong token", () =>
    withFixture(({ agentDirectory, project }) =>
      Effect.gen(function* () {
        const owner = makeWriterLease({
          agentDirectory,
          ownerNonce: token("a"),
          randomToken: () => token("9"),
        });
        const cwd = yield* owner.canonicalize(project);
        const lease = yield* acquire(owner, cwd, "mark-token-owner");
        const wrongMark = yield* owner
          .markSpawnStarted({ ...lease, ownershipToken: token("f") })
          .pipe(Effect.flip);
        expect(wrongMark).toMatchObject({ _tag: "WriterLeaseMarkError" });
        expect(lease.evidence.phase).toBe("reserved");
        const marked = yield* owner.markSpawnStarted(lease);
        expect(marked.evidence.phase).toBe("spawn-started");
        yield* owner.release(marked);
      }),
    ),
  );

  it.effect("does not unlock a lease when release presents the wrong token", () =>
    withFixture(({ agentDirectory, project }) =>
      Effect.gen(function* () {
        const owner = makeWriterLease({
          agentDirectory,
          ownerNonce: token("a"),
          randomToken: () => token("9"),
        });
        const contender = makeWriterLease({
          agentDirectory,
          ownerNonce: token("b"),
          randomToken: () => token("a"),
        });
        const cwd = yield* owner.canonicalize(project);
        const lease = yield* acquire(owner, cwd, "token-owner");
        const wrongRelease = yield* owner
          .release({ ...lease, ownershipToken: token("f") })
          .pipe(Effect.flip);
        expect(wrongRelease).toMatchObject({ _tag: "WriterLeaseReleaseError" });
        expect(
          yield* acquire(contender, cwd, "blocked-after-wrong-token").pipe(Effect.flip),
        ).toMatchObject({ _tag: "WriterLeaseConflictError", ownerRunId: "token-owner" });
        yield* owner.release(lease);
        const replacement = yield* acquire(contender, cwd, "after-correct-release");
        yield* contender.release(replacement);
      }),
    ),
  );

  it.effect("prevents delayed duplicate release from moving an ABA replacement", () =>
    withFixture(({ agentDirectory, project }) =>
      Effect.gen(function* () {
        const firstEntered = promiseGate();
        const secondEntered = promiseGate();
        const firstGate = promiseGate();
        const secondGate = promiseGate();
        const owner = makeWriterLease({
          agentDirectory,
          ownerNonce: token("a"),
          randomToken: () => token("b"),
          beforeReleaseRename: () => {
            firstEntered.open();
            return firstGate.promise;
          },
        });
        const duplicateReleaser = makeWriterLease({
          agentDirectory,
          ownerNonce: token("e"),
          randomToken: () => token("f"),
          beforeReleaseRename: () => {
            secondEntered.open();
            return secondGate.promise;
          },
        });
        const replacementOwner = makeWriterLease({
          agentDirectory,
          ownerNonce: token("c"),
          randomToken: () => token("d"),
        });
        const cwd = yield* owner.canonicalize(project);
        const lease = yield* owner.acquire({
          cwd,
          sessionId: "aba-session",
          runId: "aba-owner",
        });
        const firstRelease = Effect.runPromiseExit(owner.release(lease));
        yield* Effect.promise(() => firstEntered.promise);
        const delayedDuplicate = Effect.runPromiseExit(duplicateReleaser.release(lease));
        yield* Effect.promise(() => secondEntered.promise);

        firstGate.open();
        expect(Exit.isSuccess(yield* Effect.promise(() => firstRelease))).toBe(true);
        const replacement = yield* replacementOwner.acquire({
          cwd,
          sessionId: "replacement-session",
          runId: "aba-replacement",
        });
        secondGate.open();
        expect(Exit.isFailure(yield* Effect.promise(() => delayedDuplicate))).toBe(true);

        const evidence = yield* Effect.promise(() => readOwnerEvidence(replacement.leasePath));
        expect(evidence.ownershipToken).toBe(replacement.ownershipToken);
        yield* replacementOwner.release(replacement);
        const entries = yield* Effect.promise(() => fs.readdir(writerLeaseRoot(agentDirectory)));
        expect(entries.some((entry) => entry.includes(".tombstone-"))).toBe(true);
      }).pipe(Effect.orDie),
    ),
  );

  it.effect("admits exactly one of two simultaneous dead-owner contenders", () =>
    withFixture(({ agentDirectory, project }) =>
      Effect.gen(function* () {
        const deadPid = 2_000_000_002;
        const deadOwner = makeWriterLease({
          agentDirectory,
          parentPid: deadPid,
          ownerNonce: token("a"),
          randomToken: () => token("b"),
        });
        const cwd = yield* deadOwner.canonicalize(project);
        yield* acquire(deadOwner, cwd, "simultaneous-dead-owner");
        const contender = (ownerNonce: string, ownershipToken: string) =>
          makeWriterLease({
            agentDirectory,
            ownerNonce,
            randomToken: () => ownershipToken,
            probeOwner: (pid) => (pid === deadPid ? "dead" : "alive"),
          });
        const first = contender(token("c"), token("d"));
        const second = contender(token("e"), token("f"));
        const outcomes = yield* Effect.all(
          [
            acquire(first, cwd, "simultaneous-one").pipe(Effect.exit),
            acquire(second, cwd, "simultaneous-two").pipe(Effect.exit),
          ],
          { concurrency: 2 },
        );
        const winners = outcomes.filter(Exit.isSuccess);
        const losers = outcomes.filter(Exit.isFailure);
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        const winner = winners[0];
        if (winner && Exit.isSuccess(winner)) {
          const service = winner.value.evidence.runId === "simultaneous-one" ? first : second;
          yield* service.release(winner.value);
        }
      }),
    ),
  );

  it.effect("uses independent Node processes for live conflict and simultaneous acquisition", () =>
    withFixture(({ agentDirectory, project }) =>
      Effect.gen(function* () {
        const owner = yield* Effect.promise(() =>
          startLeaseChild(agentDirectory, project, "process-owner"),
        );
        const contender = yield* Effect.promise(() =>
          startLeaseChild(agentDirectory, project, "process-contender"),
        );
        try {
          owner.send("acquire");
          expect(yield* Effect.promise(owner.next)).toMatchObject({
            type: "acquired",
            phase: "reserved",
          });
          contender.send("acquire");
          expect(yield* Effect.promise(contender.next)).toMatchObject({
            type: "failure",
            tag: "WriterLeaseConflictError",
            reason: "live",
            ownerRunId: "process-owner",
          });
          owner.send("release");
          expect(yield* Effect.promise(owner.next)).toMatchObject({ type: "released" });
        } finally {
          yield* Effect.promise(() => Promise.all([owner.dispose(), contender.dispose()]));
        }

        const first = yield* Effect.promise(() =>
          startLeaseChild(agentDirectory, project, "simultaneous-process-one"),
        );
        const second = yield* Effect.promise(() =>
          startLeaseChild(agentDirectory, project, "simultaneous-process-two"),
        );
        try {
          first.send("acquire");
          second.send("acquire");
          const outcomes = yield* Effect.promise(() => Promise.all([first.next(), second.next()]));
          const winners = outcomes.filter((message) => message.type === "acquired");
          const losers = outcomes.filter((message) => message.type === "failure");
          expect(winners).toHaveLength(1);
          expect(losers).toHaveLength(1);
          const winner = outcomes[0]?.type === "acquired" ? first : second;
          winner.send("release");
          expect(yield* Effect.promise(winner.next)).toMatchObject({ type: "released" });
        } finally {
          yield* Effect.promise(() => Promise.all([first.dispose(), second.dispose()]));
        }
      }),
    ),
  );

  it.effect("returns a typed canonicalization failure without creating lease state", () =>
    withFixture(({ root, agentDirectory }) =>
      Effect.gen(function* () {
        const service = makeWriterLease({ agentDirectory });
        const failure = yield* service
          .canonicalize(join(root, "missing-project"))
          .pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "WriterCwdCanonicalizationError" });
        expect(
          yield* Effect.tryPromise(() => fs.readdir(agentDirectory)).pipe(Effect.orDie),
        ).toEqual([]);
      }),
    ),
  );
});
