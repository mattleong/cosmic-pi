import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import { vi } from "vitest";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Str from "effect/String";
import { nodeFilePlatformLayer, signalProcess, utf8ByteLength } from "pi-cosmic-core";
import { nodePath } from "pi-cosmic-core/platform/node-builtins";
import { provideBuiltLayer } from "pi-cosmic-core/testing";
import {
  LocalProcess,
  makeBackgroundProcessEnvironment,
  type HostShellSettings,
  type LocalProcessHandle,
  type LocalProcessOutput,
  type LocalProcessRequest,
} from "../src/boundary/local-process.ts";
import { BACKGROUND_TASK_FIELD_BOUNDS } from "../src/task/bounds.ts";

// Real processes start slowly on loaded runners. These bounds only end a hung test; no
// assertion depends on how quickly a process starts or exits.
vi.setConfig({ testTimeout: 60_000 });
const processTimeout = "20 seconds";

const withLocalProcess = <A, E>(
  effect: Effect.Effect<A, E, LocalProcess | Scope.Scope>,
  shell: HostShellSettings = {},
) => effect.pipe(Effect.scoped, provideBuiltLayer(LocalProcess.layerFor(shell)));
const spawnProcess = (command: string, overrides: Partial<LocalProcessRequest> = {}) =>
  LocalProcess.use((processes) =>
    processes.spawn({ command, cwd: ".", ingressBufferBytes: 64 * 1024, ...overrides }),
  );
const collectUntilExit = (handle: LocalProcessHandle) =>
  Effect.all(
    { events: handle.output.pipe(Stream.runCollect), exit: handle.awaitExit },
    { concurrency: "unbounded" },
  );

const firstOutput = (handle: LocalProcessHandle) =>
  handle.output.pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.timeout(processTimeout),
    Effect.map((events) =>
      Arr.join(
        Arr.map([...events], (event) => event.text),
        "",
      ),
    ),
  );

const processAlive = (pid: number) => signalProcess(pid, 0) === "present";

const pollUntil = (done: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + 10_000;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      if (yield* done) return true;
      yield* Effect.sleep("10 millis");
    }
    return yield* done;
  });

const awaitProcessDeath = (pid: number) => pollUntil(Effect.sync(() => !processAlive(pid)));

const outputText = (events: Iterable<LocalProcessOutput>) =>
  Arr.join(
    Arr.map([...events], (event) => event.text),
    "",
  );

/** A stand-in shell that prints the command it was asked to run instead of running it. */
const echoingShell = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const shell = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "bg-shell-" }), "shell");
  yield* fs.writeFileString(shell, `#!/bin/sh\nprintf 'ran:%s' "$2"\n`);
  yield* fs.chmod(shell, 0o755);
  return shell;
}).pipe(Effect.provide(nodeFilePlatformLayer));

describe("local process boundary", () => {
  it("filters blocked environment keys with case-sensitive names", () => {
    const blocked = {
      BASH_ENV: "bash",
      ENV: "shell",
      NODE_OPTIONS: "--inspect",
      NODE_PATH: "/modules",
      PI_SESSION_FILE: "/private/session.jsonl",
      PI_SESSION_ID: "private",
    };
    expect(makeBackgroundProcessEnvironment({ PATH: "/bin", ...blocked })).toEqual({
      PATH: "/bin",
    });

    const lowerCase = {
      bash_env: "bash",
      env: "shell",
      node_options: "--inspect",
      node_path: "/modules",
      pi_session_file: "/private/session.jsonl",
      pi_session_id: "private",
    };
    expect(makeBackgroundProcessEnvironment(lowerCase)).toEqual(lowerCase);
  });

  it("puts Pi's tool directory on PATH once", () => {
    expect(makeBackgroundProcessEnvironment({ PATH: "/usr/bin:/bin" }, "/agent/bin")).toEqual({
      PATH: "/agent/bin:/usr/bin:/bin",
    });
    expect(makeBackgroundProcessEnvironment({ PATH: "/bin:/agent/bin" }, "/agent/bin")).toEqual({
      PATH: "/bin:/agent/bin",
    });
    expect(makeBackgroundProcessEnvironment({}, "/agent/bin")).toEqual({ PATH: "/agent/bin" });
  });

  it("passes color settings through without requesting color", () => {
    expect(makeBackgroundProcessEnvironment({ PATH: "/bin" }, "/agent/bin")).not.toHaveProperty(
      "FORCE_COLOR",
    );
    for (const color of [{ FORCE_COLOR: "0" }, { FORCE_COLOR: "3" }, { NO_COLOR: "1" }])
      expect(makeBackgroundProcessEnvironment({ PATH: "/bin", ...color })).toEqual({
        PATH: "/bin",
        ...color,
      });
  });

  it.live("runs commands in bash when no shell is configured", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const result = yield* collectUntilExit(
          yield* spawnProcess("[[ 1 == 1 ]] && echo {1..3} && [[ ! -o posix ]] && echo bash"),
        );
        expect(result.exit.exitCode).toBe(0);
        expect(outputText(result.events)).toBe("1 2 3\nbash\n");
      }),
    ),
  );

  it.live("runs Pi's shell with Pi's command prefix", () =>
    Effect.gen(function* () {
      const prefixed = yield* withLocalProcess(
        Effect.flatMap(spawnProcess('echo "$greeting"'), collectUntilExit),
        { commandPrefix: "greeting=hello" },
      );
      expect(outputText(prefixed.events)).toBe("hello\n");

      const shell = yield* echoingShell;
      const custom = yield* withLocalProcess(
        Effect.flatMap(spawnProcess("build"), collectUntilExit),
        {
          shellPath: shell,
          commandPrefix: "setup",
        },
      );
      expect(outputText(custom.events)).toBe("ran:setup\nbuild");
    }).pipe(Effect.scoped),
  );

  it.live("lets the package shellPath replace Pi's shell and command prefix", () =>
    Effect.gen(function* () {
      const shell = yield* echoingShell;
      const result = yield* withLocalProcess(
        Effect.flatMap(spawnProcess("build", { shellPath: shell }), collectUntilExit),
        { shellPath: "/bin/bash", commandPrefix: "exit 9" },
      );
      expect(result.exit.exitCode).toBe(0);
      expect(outputText(result.events)).toBe("ran:build");
    }).pipe(Effect.scoped),
  );

  it.live("finds the package shellPath as Node's shell option does", () =>
    Effect.gen(function* () {
      const bare = yield* withLocalProcess(
        Effect.flatMap(spawnProcess('echo "$0"', { shellPath: "sh" }), collectUntilExit),
        { commandPrefix: "exit 9" },
      );
      expect(bare.exit.exitCode).toBe(0);
      expect(outputText(bare.events)).toBe("sh\n");

      const shell = yield* echoingShell;
      const relative = yield* withLocalProcess(
        Effect.flatMap(
          spawnProcess("build", { shellPath: "./shell", cwd: nodePath.dirname(shell) }),
          collectUntilExit,
        ),
      );
      expect(outputText(relative.events)).toBe("ran:build");

      const missing = yield* withLocalProcess(
        spawnProcess("true", { shellPath: "no-such-shell-for-tasks" }).pipe(Effect.flip),
      );
      expect(missing.message).toContain("no-such-shell-for-tasks");
    }).pipe(Effect.scoped),
  );

  it.live("ends the task's input when a stop is dispatched", () =>
    withLocalProcess(
      Effect.gen(function* () {
        // The task ignores SIGTERM, so only the end of its input lets it exit before a forced stop.
        const handle = yield* spawnProcess(
          "trap '' TERM; printf ready; cat >/dev/null; printf ' input ended'",
        );
        expect(yield* firstOutput(handle)).toBe("ready");
        yield* handle.terminate("graceful");
        const rest = yield* collectUntilExit(handle).pipe(Effect.timeout(processTimeout));
        expect(rest.exit).toEqual({ exitCode: 0 });
        expect(outputText(rest.events)).toBe(" input ended");
      }),
    ),
  );

  it.live("keeps stdin open until the task is stopped", () =>
    withLocalProcess(
      Effect.gen(function* () {
        // Like esbuild --watch, this exits as soon as its input ends.
        const handle = yield* spawnProcess(
          `node -e "process.stdin.on('end', () => process.exit(3)); process.stdin.resume(); process.stdout.write('ready')"`,
        );
        expect(yield* firstOutput(handle)).toBe("ready");
        const early = yield* handle.awaitExit.pipe(Effect.timeoutOption("300 millis"));
        expect(Option.isNone(early)).toBe(true);
        yield* handle.terminate("graceful");
        yield* handle.awaitExit.pipe(Effect.timeout(processTimeout));
        expect(yield* awaitProcessDeath(handle.pid)).toBe(true);
      }),
    ),
  );

  it.live("captures stdout, stderr, and exit", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const handle = yield* spawnProcess(
          `node -e "process.stdout.write('out'); process.stderr.write('err')"`,
        );
        const result = yield* collectUntilExit(handle);
        expect(result.exit.exitCode).toBe(0);
        const output = Arr.join(
          Arr.map([...result.events], (event) => `${event.stream}:${event.text}`),
          "|",
        );
        expect(output).toContain("stdout:out");
        expect(output).toContain("stderr:err");
      }),
    ),
  );

  it.live("runs a heredoc command as long as task admission allows", () =>
    withLocalProcess(
      Effect.gen(function* () {
        // Two-byte characters make the UTF-8 size, which the shell argument limit counts, larger
        // than the character count.
        const line = `${Fn.pipe("é", Str.repeat(63))}\n`;
        const lineBytes = utf8ByteLength(line);
        const lines = Math.floor((BACKGROUND_TASK_FIELD_BOUNDS.maxCommandBytes - 64) / lineBytes);
        const command = `cat <<'EOF' | wc -c\n${Fn.pipe(line, Str.repeat(lines))}EOF\n`;
        expect(utf8ByteLength(command)).toBeLessThanOrEqual(
          BACKGROUND_TASK_FIELD_BOUNDS.maxCommandBytes,
        );
        const result = yield* collectUntilExit(yield* spawnProcess(command));
        expect(result.exit.exitCode).toBe(0);
        const output = Arr.join(
          Arr.map([...result.events], (event) => event.text),
          "",
        );
        expect(Number(Str.trim(output))).toBe(lines * lineBytes);
      }),
    ),
  );

  it.live("redacts the command when its shell cannot start", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const result = yield* Effect.result(
          spawnProcess("echo api_key=FAKE_SECRET_123", {
            shellPath: "/definitely/missing/pi-background-shell",
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.reason).toBe("spawn");
          expect(result.failure.message).not.toContain("FAKE_SECRET_123");
          expect(String(result.failure)).not.toContain("FAKE_SECRET_123");
        }
      }),
    ),
  );

  it.live("keeps queued output within the configured byte budget", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const producedBytes = 2_000;
        const ingressBufferBytes = 1_024;
        const handle = yield* spawnProcess(
          `node -e "process.stdout.write('A'.repeat(${producedBytes}))"`,
          { ingressBufferBytes },
        );
        const result = yield* collectUntilExit(handle);
        expect(result.exit.exitCode).toBe(0);
        const deliveredBytes = Arr.reduce(
          Arr.filter([...result.events], (event) => event.stream === "stdout"),
          0,
          (total, event) => total + Buffer.byteLength(event.text, "utf8"),
        );
        expect(deliveredBytes).toBeLessThanOrEqual(ingressBufferBytes);
        expect(handle.droppedOutputBytes() + deliveredBytes).toBe(producedBytes);
      }),
    ),
  );

  it.live("settles after killing descendants that retain inherited pipes", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const handle = yield* spawnProcess(
          `node -e "const {spawn}=require('child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); child.unref();"`,
        );
        const result = yield* collectUntilExit(handle).pipe(Effect.timeout(processTimeout));
        expect(result.exit.exitCode).toBe(0);
      }),
    ),
  );

  it.live("scope release terminates a running leader and descendant", () =>
    Effect.gen(function* () {
      const pids = yield* Effect.gen(function* () {
        const handle = yield* spawnProcess(
          `node -e "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.stdout.write(String(child.pid)); setInterval(()=>{},1000)"`,
        );
        const events = yield* handle.output.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout(processTimeout),
        );
        const descendant = Number(
          Fn.pipe(
            [...events][0]?.text,
            Option.fromUndefinedOr,
            Option.map(Str.trim),
            Option.getOrUndefined,
          ),
        );
        expect(Number.isSafeInteger(descendant)).toBe(true);
        return { leader: handle.pid, descendant };
      }).pipe(Effect.scoped, provideBuiltLayer(LocalProcess.layer));

      expect(yield* awaitProcessDeath(pids.leader)).toBe(true);
      expect(yield* awaitProcessDeath(pids.descendant)).toBe(true);
    }),
  );

  it.live(
    "a graceful stop keeps the group's grace window after a compound command's leader exits",
    () =>
      withLocalProcess(
        Effect.gen(function* () {
          const handle = yield* spawnProcess(
            `node -e "process.on('SIGTERM', () => setTimeout(() => { process.stdout.write('cleaned'); process.exit(0) }, 200)); process.stdout.write('ready'); setInterval(() => {}, 1000)"; true`,
          );
          expect(yield* firstOutput(handle)).toBe("ready");
          yield* handle.terminate("graceful");
          const result = yield* collectUntilExit(handle).pipe(Effect.timeout(processTimeout));
          expect(result.exit).toEqual({ exitCode: null, signal: "SIGTERM" });
          expect(
            Arr.join(
              Arr.map([...result.events], (event) => event.text),
              "",
            ),
          ).toContain("cleaned");
        }),
      ),
  );

  it.live("force ends a graceful stop's group grace window and kills lingering descendants", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const handle = yield* spawnProcess(
          `node -e "process.on('SIGTERM', () => {}); process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)"; true`,
        );
        const descendant = Number(yield* firstOutput(handle));
        expect(Number.isSafeInteger(descendant)).toBe(true);
        expect(yield* handle.leaderExited).toBe(false);
        yield* handle.terminate("graceful");
        // The shell leader dies of SIGTERM; its descendant ignores it and holds the group open.
        expect(yield* pollUntil(handle.leaderExited)).toBe(true);
        const early = yield* handle.awaitExit.pipe(Effect.timeoutOption("300 millis"));
        expect(Option.isNone(early)).toBe(true);
        expect(processAlive(descendant)).toBe(true);
        yield* handle.terminate("force");
        const exit = yield* handle.awaitExit.pipe(Effect.timeout(processTimeout));
        expect(exit).toEqual({ exitCode: null, signal: "SIGTERM" });
        expect(yield* awaitProcessDeath(descendant)).toBe(true);
      }),
    ),
  );

  it.live("counts queued output as dropped when its delivery is abandoned", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const handle = yield* spawnProcess(
          `node -e "process.stdout.write('A'.repeat(1000)); setTimeout(() => {}, 200)"`,
        );
        yield* handle.awaitExit;
        yield* handle.abandonOutput;
        expect(handle.droppedOutputBytes()).toBe(1000);
        const delivered = yield* handle.output.pipe(
          Stream.runCollect,
          Effect.timeout(processTimeout),
        );
        expect([...delivered]).toEqual([]);
      }),
    ),
  );

  it.live("counts the rest of a pulled batch as dropped when an abandoned reader stops", () =>
    withLocalProcess(
      Effect.gen(function* () {
        // Separate streams guarantee two events, both queued before the reader's first pull.
        const handle = yield* spawnProcess(
          `node -e "process.stdout.write('A'.repeat(100)); process.stderr.write('B'.repeat(200)); setTimeout(() => {}, 200)"`,
        );
        yield* handle.awaitExit;
        const received = yield* Deferred.make<LocalProcessOutput>();
        const reader = yield* handle.output.pipe(
          Stream.runForEach((event) =>
            Deferred.succeed(received, event).pipe(Effect.andThen(Effect.never)),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        const first = yield* Deferred.await(received).pipe(Effect.timeout(processTimeout));

        yield* handle.abandonOutput;
        yield* Fiber.interrupt(reader);
        expect(handle.droppedOutputBytes()).toBe(300 - Buffer.byteLength(first.text, "utf8"));
      }),
    ),
  );

  it.live("counts output that arrives after its delivery was abandoned as dropped", () =>
    withLocalProcess(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const marker = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "bg-abandon-" }),
          "abandoned",
        );
        // The command writes only once the marker exists, after the test abandons delivery.
        const handle = yield* spawnProcess(
          `node -e "const fs = require('node:fs'); const poll = setInterval(() => { if (!fs.existsSync(process.argv[1])) return; clearInterval(poll); process.stdout.write('C'.repeat(150)); }, 10)" '${marker}'`,
        );
        yield* handle.abandonOutput;
        yield* fs.writeFileString(marker, "");
        yield* handle.awaitExit;

        // Pipe data may still follow the leader's exit.
        const dropped = yield* Effect.sync(handle.droppedOutputBytes).pipe(
          Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: (bytes) => bytes >= 150 }),
          Effect.timeout(processTimeout),
        );
        expect(dropped).toBe(150);
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
    ),
  );

  it.live("never signals a process group again after it settled, through scope release", () =>
    Effect.gen(function* () {
      const kill = yield* Effect.acquireRelease(
        Effect.sync(() => vi.spyOn(process, "kill")),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      for (const [command, exitCode] of [
        ["exit 0", 0],
        ["exit 3", 3],
      ] as const) {
        const pid = yield* Effect.gen(function* () {
          const handle = yield* spawnProcess(command);
          expect(yield* handle.awaitExit).toEqual({ exitCode });
          kill.mockClear();
          yield* handle.terminate("graceful");
          yield* handle.terminate("force");
          // The scope that owns the process closes some time after it settled.
          yield* Effect.sleep("100 millis");
          return handle.pid;
        }).pipe(Effect.scoped, provideBuiltLayer(LocalProcess.layer));
        expect(
          Arr.filter(kill.mock.calls, ([target]) => Math.abs(target) === pid),
          command,
        ).toEqual([]);
      }
    }).pipe(Effect.scoped),
  );
});
