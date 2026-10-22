import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Scope from "effect/Scope";
import { vi } from "vitest";
import { guardProcessGroupAtHostExit, signalProcessGroup } from "../index.ts";
import { spawnIpcChild } from "../src/testing/ipc-child.ts";

vi.setConfig({ testTimeout: 30_000 });

const childScript = fileURLToPath(
  new URL("./fixtures/process-group-exit-guard-child.ts", import.meta.url),
);

const groupAbsent = (pid: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (signalProcessGroup(pid, 0) === "absent") return true;
      yield* Effect.sleep(10);
    }
    return false;
  });

const hostExit = (mode: "guarded" | "released") =>
  Effect.gen(function* () {
    const host = yield* spawnIpcChild(childScript, [mode], { timeout: "10 seconds" });
    yield* host.wait("ready");
    const announced = host.messages.find(
      (message): message is string => Predicate.isString(message) && message.startsWith("group:"),
    );
    const pid = Number(announced?.slice("group:".length));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    yield* Effect.addFinalizer(() => Effect.sync(() => signalProcessGroup(pid, "SIGKILL")));
    expect(signalProcessGroup(pid, 0)).toBe("present");
    host.child.send?.("exit");
    yield* host.exited;
    expect(host.child.exitCode).toBe(9);
    return pid;
  });

describe("process-group host-exit guard", () => {
  it.live("kills a guarded group when its host exits without closing scopes", () =>
    Effect.gen(function* () {
      const pid = yield* hostExit("guarded");
      expect(yield* groupAbsent(pid)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("leaves a released group to its owner when the host exits", () =>
    Effect.gen(function* () {
      const pid = yield* hostExit("released");
      yield* Effect.sleep(100);
      expect(signalProcessGroup(pid, 0)).toBe("present");
    }).pipe(Effect.scoped),
  );

  it.effect("holds one host-exit listener only while a guard is active", () =>
    Effect.gen(function* () {
      const baseline = process.listenerCount("exit");
      const scope = yield* Scope.make();
      const first = yield* guardProcessGroupAtHostExit(2_147_483_000).pipe(Scope.provide(scope));
      yield* guardProcessGroupAtHostExit(2_147_483_001).pipe(Scope.provide(scope));
      expect(process.listenerCount("exit")).toBe(baseline + 1);
      yield* first.release;
      yield* first.release;
      expect(process.listenerCount("exit")).toBe(baseline + 1);
      yield* Scope.close(scope, Exit.void);
      expect(process.listenerCount("exit")).toBe(baseline);
    }),
  );
});
