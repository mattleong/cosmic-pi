import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { makeMcpActivity } from "../../src/activity/service.ts";
import {
  mcpActivityDetail,
  mcpFooterStatus,
  projectMcpActivity,
} from "../../src/activity/model.ts";

const serialize = <Value>(value: Value) => JSON.stringify(value);
const idle = { connected: 0, active: 0, queued: 0, attention: 0 };
describe("MCP operation journal", () => {
  it.effect("updates one owned row through real phases, cleanup and terminal settlement", () =>
    Effect.gen(function* () {
      const journal = yield* makeMcpActivity();
      const handle = yield* journal.begin({ operation: "auth", server: "docs" });
      const first = journal.snapshot()[0]!;
      yield* TestClock.adjust(250);
      yield* journal.update(handle, { phase: "browser-approval" });
      const waiting = journal.snapshot()[0]!;
      expect(journal.snapshot()).toHaveLength(1);
      expect(waiting.id).toBe(first.id);
      expect(waiting.revision).not.toBe(first.revision);
      expect(waiting.updatedAt - first.startedAt).toBe(250);
      expect(projectMcpActivity(journal.snapshot())[0]).toMatchObject({
        kind: "command",
        status: "needs-input",
        inputTarget: "user",
      });
      yield* journal.update(handle, { phase: "stopping" });
      yield* journal.update(handle, { phase: "saving-credentials" });
      expect(journal.snapshot()[0]?.status).toBe("stopping");
      expect(projectMcpActivity(journal.snapshot())[0]).not.toHaveProperty("inputTarget");
      yield* journal.finish(handle, { status: "cancelled" });
      const terminal = journal.snapshot()[0];
      yield* journal.finish(handle, { status: "done" });
      yield* journal.update(handle, { phase: "finalizing" });
      expect(journal.snapshot()[0]).toBe(terminal);
      expect(terminal?.status).toBe("cancelled");
      expect(Object.isFrozen(journal.snapshot())).toBe(true);
      expect(Object.isFrozen(terminal)).toBe(true);
    }),
  );

  it.effect(
    "cannot mutate another activation or a forged handle and never asks for input for connections",
    () =>
      Effect.gen(function* () {
        const old = yield* makeMcpActivity();
        const journal = yield* makeMcpActivity();
        const oldHandle = yield* old.begin({ operation: "auth", server: "docs" });
        const handle = yield* journal.begin({ operation: "connect", server: "docs" });
        const first = journal.snapshot()[0];
        yield* journal.finish(oldHandle, { status: "failed" });
        yield* journal.finish({ id: handle.id }, { status: "failed" });
        expect(journal.snapshot()[0]).toBe(first);
        yield* journal.update(handle, { phase: "browser-approval" });
        expect(journal.snapshot()[0]?.status).toBe("running");
      }),
  );

  it.effect("bounds active and terminal rows without evicting active owners", () =>
    Effect.gen(function* () {
      const journal = yield* makeMcpActivity({ activeLimit: 2, terminalLimit: 2 });
      const pinned = yield* journal.begin({ operation: "refresh", server: "docs" });
      const current = yield* journal.begin({ operation: "connect", server: "docs" });
      const overflow = yield* journal.begin({ operation: "auth", server: "docs" });
      expect(journal.snapshot()).toHaveLength(2);
      yield* journal.finish(overflow, { status: "failed" });
      yield* journal.finish(current, { status: "done" });
      for (let index = 0; index < 4; index++) {
        const next = yield* journal.begin({ operation: "connect", server: "docs" });
        yield* journal.finish(next, { status: "failed", kind: "cleanup" });
      }
      expect(journal.snapshot()).toHaveLength(3);
      expect(journal.snapshot()[0]?.id).toBe(pinned.id);
      expect(journal.snapshot().filter((entry) => entry.status === "failed")).toHaveLength(2);
    }),
  );

  it.effect("publishes and retains a late failure after newer completions fill the journal", () =>
    Effect.gen(function* () {
      const journal = yield* makeMcpActivity({ terminalLimit: 2 });
      const old = yield* journal.begin({ operation: "auth", server: "docs" });
      const active = yield* journal.begin({ operation: "refresh", server: "docs" });
      for (let index = 0; index < 3; index++) {
        const next = yield* journal.begin({ operation: "connect", server: "docs" });
        yield* journal.finish(next, { status: "done" });
      }
      let observed = journal.snapshot();
      journal.subscribe(() => {
        observed = journal.snapshot();
      });
      yield* journal.finish(old, { status: "failed", kind: "cleanup" });
      expect(observed.find((entry) => entry.id === old.id)).toMatchObject({ status: "failed" });
      expect(observed.find((entry) => entry.id === active.id)).toMatchObject({ status: "running" });
      expect(observed).toHaveLength(3);
      expect(mcpFooterStatus(idle, observed, true)).toBeDefined();
    }),
  );

  it.effect(
    "retains only fixed failure evidence and clears observers and authority on scope close",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const journal = yield* makeMcpActivity().pipe(Effect.provideService(Scope.Scope, scope));
        let observed = journal.snapshot();
        journal.subscribe(() => {
          throw new Error("private-auth-error");
        });
        const unsubscribe = journal.subscribe(() => {
          observed = journal.snapshot();
        });
        const secret = "https://issuer.invalid/auth?state=PRIVATE-STATE&code=PRIVATE-CODE";
        yield* journal.begin({ operation: "auth", server: secret });
        expect(journal.snapshot()).toHaveLength(0);
        const handle = yield* journal.begin({ operation: "auth", server: "docs" });
        yield* journal.finish(handle, {
          status: "failed",
          kind: "cleanup",
          reason: "oauth-mutation-unresolved",
        });
        expect(observed[0]?.failure?.reason).toBe("oauth-mutation-unresolved");
        const details = mcpActivityDetail(observed[0]!);
        expect(details).toMatch(/mutation|credential/i);
        expect(serialize([observed, projectMcpActivity(observed), details])).not.toContain(
          "PRIVATE",
        );
        yield* Scope.close(scope, Exit.void);
        expect(journal.snapshot()).toHaveLength(0);
        expect(observed).toHaveLength(0);
        unsubscribe();
        yield* journal.update(handle, { phase: "finalizing" });
        yield* journal.begin({ operation: "connect", server: "docs" });
        expect(journal.snapshot()).toHaveLength(0);
      }),
  );

  it.effect("keeps idle servers out of Activity and hides wholly inactive status", () =>
    Effect.gen(function* () {
      const journal = yield* makeMcpActivity();
      expect(projectMcpActivity(journal.snapshot())).toEqual([]);
      expect(mcpFooterStatus(idle, [], false)).toBeUndefined();
      expect(mcpFooterStatus({ ...idle, connected: 1 }, [], true)).toBeDefined();
      const handle = yield* journal.begin({ operation: "auth", server: "docs" });
      expect(mcpFooterStatus(idle, journal.snapshot(), false)).toBeDefined();
      expect(mcpFooterStatus(idle, journal.snapshot(), true)).toBeUndefined();
      yield* journal.finish(handle, { status: "failed", kind: "cleanup" });
      expect(mcpFooterStatus(idle, journal.snapshot(), true)).toBeDefined();
    }),
  );
});
