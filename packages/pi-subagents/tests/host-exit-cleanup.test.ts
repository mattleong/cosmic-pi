import { fileURLToPath } from "node:url";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Scope from "effect/Scope";
import { vi } from "vitest";
import { signalProcessGroup } from "pi-cosmic-core";
import { spawnIpcChild, temporaryDirectory } from "pi-cosmic-core/testing";
import { acquireLocalCliTransport } from "../src/boundary/local-cli-transport.ts";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

vi.setConfig({ testTimeout: 30_000 });

const hostScript = fileURLToPath(new URL("./fixtures/abrupt-exit-host.ts", import.meta.url));

const groupGone = (pid: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (signalProcessGroup(pid, 0) === "absent") return true;
      yield* Effect.sleep("10 millis");
    }
    return false;
  });

const killGroupAfterward = (pid: number) =>
  Effect.addFinalizer(() => Effect.sync(() => signalProcessGroup(pid, "SIGKILL")));

// The host-exit guard holds one process `exit` listener exactly while any group is guarded.
const exitListenersReach = (expected: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (process.listenerCount("exit") === expected) return true;
      yield* Effect.sleep("10 millis");
    }
    return false;
  });

const openShell = (script: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const handle = yield* acquireLocalCliTransport({
      executable: "/bin/sh",
      args: ["-c", script],
      env: { PATH: "/usr/bin:/bin" },
      cwd: process.cwd(),
      writer: false,
    }).pipe(Scope.provide(scope));
    yield* killGroupAfterward(handle.pid);
    return { handle, scope };
  });

describe("host exit cleanup", () => {
  it.live("kills a subagent child's process group when its host exits without shutdown", () =>
    Effect.gen(function* () {
      const agentDirectory = yield* temporaryDirectory("pi-subagents-abrupt-exit-");
      // The host transpiles the launch boundary on a cold start, which takes over 10 seconds on
      // loaded CI runners.
      const host = yield* spawnIpcChild(hostScript, [agentDirectory], { timeout: "25 seconds" });
      yield* host.wait("ready");
      const announced = Option.getOrUndefined(
        Arr.findFirst(Arr.filter(host.messages, Predicate.isString), (message) =>
          Fn.pipe(message, Str.startsWith("group:")),
        ),
      );
      assert(announced !== undefined);
      const pid = Number(Fn.pipe(announced, Str.slice("group:".length)));
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      yield* killGroupAfterward(pid);
      expect(signalProcessGroup(pid, 0)).toBe("present");

      host.child.send?.("exit");
      yield* host.exited;
      expect(host.child.exitCode).toBe(9);
      expect(yield* groupGone(pid)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("stops guarding a child's group once it is gone after the child exits", () =>
    Effect.gen(function* () {
      const baseline = process.listenerCount("exit");
      const { handle, scope } = yield* openShell("exit 0");
      yield* handle.awaitExit;
      expect(yield* exitListenersReach(baseline)).toBe(true);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.scoped),
  );

  it.live("keeps guarding a group that outlives its leader until cleanup confirms it", () =>
    Effect.gen(function* () {
      const baseline = process.listenerCount("exit");
      const { handle, scope } = yield* openShell("sleep 60 </dev/null >/dev/null 2>&1 & exit 0");
      yield* handle.awaitExit;
      yield* Effect.sleep("300 millis");
      expect(process.listenerCount("exit")).toBe(baseline + 1);
      expect(signalProcessGroup(handle.pid, 0)).toBe("present");

      yield* Scope.close(scope, Exit.void);
      expect(signalProcessGroup(handle.pid, 0)).toBe("absent");
      expect(process.listenerCount("exit")).toBe(baseline);
    }).pipe(Effect.scoped),
  );
});
