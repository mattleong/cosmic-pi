// Test entry point composes the subject Layer once.
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { provideBuiltLayer } from "pi-cosmic-core";
import { HerdrHost } from "../src/boundary/herdr-host.ts";
import {
  fakeTopology,
  hostLayer,
  launchInRunScope,
  launchRun,
} from "./fixtures/herdr-host-fixture.ts";

describe("Herdr launch ownership hardening", () => {
  it.live("keeps a committed run quarantined after restored-looking ownership evidence", () => {
    const fake = fakeTopology();
    const scenario = Effect.gen(function* () {
      const host = yield* HerdrHost;
      const initialFocus = fake.focusedTopology();
      const hosted = yield* launchRun(host, "agent-committed-mismatch");
      const exact = fake.agents.get(hosted.paneId)!;
      fake.agents.set(hosted.paneId, {
        ...exact,
        agentSession: { ...exact.agentSession!, value: "native-restored-unowned" },
      });
      expect(yield* hosted.close.pipe(Effect.flip)).toMatchObject({
        code: "herdr_ownership_mismatch",
      });
      fake.agents.set(hosted.paneId, exact);
      expect(yield* hosted.close.pipe(Effect.flip)).toMatchObject({
        code: "herdr_ownership_mismatch",
        message: expect.stringContaining("quarantined"),
      });
      expect(fake.closedPanes).toEqual([]);
      expect(fake.callerPaneLive()).toBe(true);
      expect(fake.cleanupAuthorizations()).toBe(0);
      expect(fake.focusedTopology()).toEqual(initialFocus);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
    return Effect.gen(function* () {
      expect(Exit.isFailure(yield* scenario.pipe(Effect.exit))).toBe(true);
    });
  });

  it.live("never retries an outcome-uncertain committed close", () => {
    const fake = fakeTopology();
    const scenario = Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* launchRun(host, "agent-uncertain-close");
      fake.inject("failPaneCloseAfterApply");
      expect(yield* hosted.close.pipe(Effect.flip)).toMatchObject({
        code: "herdr_close_pane_outcome_uncertain",
      });
      expect(yield* hosted.close.pipe(Effect.flip)).toMatchObject({
        code: "herdr_ownership_mismatch",
        message: expect.stringContaining("quarantined"),
      });
      expect(fake.closedPanes).toEqual([hosted.paneId]);
      expect(fake.callerPaneLive()).toBe(true);
      expect(fake.cleanupAuthorizations()).toBe(0);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
    return Effect.gen(function* () {
      const exit = yield* scenario.pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.every(Cause.isDieReason)).toBe(true);
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && Cause.isCause(reason.defect),
          ),
        ).toBe(false);
      }
      expect(fake.closedPanes).toHaveLength(1);
      expect(fake.callerPaneLive()).toBe(true);
    });
  });

  it.live("refuses to collapse the user tab when the subagent is its final pane", () => {
    const fake = fakeTopology();
    const scenario = Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* launchRun(host, "agent-last-pane");
      fake.removeCallerPane();
      expect(yield* hosted.close.pipe(Effect.flip)).toMatchObject({
        code: "herdr_ownership_mismatch",
        message: expect.stringContaining("last visible pane"),
      });
      expect(fake.closedPanes).toEqual([]);
      expect(fake.cleanupAuthorizations()).toBe(0);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
    return Effect.gen(function* () {
      expect(Exit.isFailure(yield* scenario.pipe(Effect.exit))).toBe(true);
    });
  });

  it.live("commits close ownership before observing interruption", () => {
    const fake = fakeTopology();
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* launchRun(host, "agent-interrupted-close");
      fake.blockSnapshotAfterPaneClose();
      const closing = yield* hosted.close.pipe(Effect.forkScoped);
      yield* fake.awaitBlockedPostCloseSnapshot();
      const interrupting = yield* Fiber.interrupt(closing).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      fake.releaseBlockedPostCloseSnapshot();
      yield* Fiber.join(interrupting);
      expect(fake.closedPanes).toEqual([hosted.paneId]);
      expect(fake.callerPaneLive()).toBe(true);
      expect(fake.cleanupAuthorizations()).toBe(1);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live("quarantines terminal drift without changing focus", () => {
    const fake = fakeTopology();
    fake.switchToOtherTab();
    fake.inject("replaceTerminalDuringShellInspection");
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const initialFocus = fake.focusedTopology();
      const { launched, closeRunScope } = yield* launchInRunScope(host, "agent-replaced-terminal");
      expect(Exit.isFailure(launched)).toBe(true);
      expect(fake.paneCommands).toEqual([]);
      expect(fake.cleanupAuthorizations()).toBe(0);
      expect(fake.focusedTopology()).toEqual(initialFocus);
      expect(Exit.isFailure(yield* closeRunScope)).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  const activation = ["activate pane input", "activate pane input"];
  for (const [attestation, marker, runId, operations] of [
    ["activation", "confirm pane input", "agent-post-activation-drift", activation],
    [
      "environment",
      "confirm pane environment",
      "agent-pre-secret-drift",
      [...activation, "prepare pane environment"],
    ],
  ] as const) {
    it.live(`quarantines terminal drift observed after ${attestation} attestation`, () => {
      const fake = fakeTopology();
      if (attestation === "environment") fake.inject("validSecretBootstrap");
      fake.driftAfterMarker(marker);
      return Effect.gen(function* () {
        const host = yield* HerdrHost;
        const { launched, closeRunScope } = yield* launchInRunScope(host, runId);
        expect(Exit.isFailure(launched)).toBe(true);
        expect(fake.paneCommands.map(({ operation }) => operation)).toEqual(operations);
        expect(fake.callerPaneLive()).toBe(true);
        expect(fake.cleanupAuthorizations()).toBe(0);
        expect(Exit.isFailure(yield* closeRunScope)).toBe(true);
      }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
    });
  }

  it.live("re-proves foreground-shell readiness before secret bootstrap", () => {
    const fake = fakeTopology();
    fake.inject("validSecretBootstrap");
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* launchRun(host, "agent-secret-shell");
      expect(fake.paneCommands.map(({ operation }) => operation)).toEqual([
        "activate pane input",
        "activate pane input",
        "prepare pane environment",
        "confirm pane shell",
        "load pane secrets",
        "confirm pane shell",
      ]);
      expect(fake.shellProcessInspections.get(hosted.paneId)).toBeGreaterThanOrEqual(3);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live("rejects duplicate caller workspace, tab, and terminal selectors before splitting", () =>
    Effect.gen(function* () {
      for (const selector of ["workspace", "tab", "terminal"] as const) {
        const fake = fakeTopology();
        fake.injectDuplicateSelector(selector);
        yield* Effect.gen(function* () {
          const host = yield* HerdrHost;
          const { launched, closeRunScope } = yield* launchInRunScope(
            host,
            `agent-duplicate-${selector}`,
          );
          expect(Exit.isFailure(launched)).toBe(true);
          expect(fake.splitCalls()).toBe(0);
          expect(fake.paneCommands).toEqual([]);
          expect(fake.closedPanes).toEqual([]);
          expect(fake.callerPaneLive()).toBe(true);
          expect(fake.cleanupAuthorizations()).toBe(0);
          expect(Exit.isSuccess(yield* closeRunScope)).toBe(true);
          expect(fake.cleanupAuthorizations()).toBe(0);
          expect(fake.harnessCleanups()).toBe(1);
        }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
      }
    }),
  );

  it.live("quarantines mismatched process-info, start-response, and post-start name evidence", () =>
    Effect.gen(function* () {
      for (const mismatch of ["process", "start", "name"] as const) {
        const fake = fakeTopology();
        if (mismatch === "process") fake.inject("processInfoReturnsWrongPane");
        if (mismatch === "start") fake.inject("startReturnsMismatchedAgent");
        if (mismatch === "name") fake.inject("duplicateNameAfterStart");
        yield* Effect.gen(function* () {
          const host = yield* HerdrHost;
          const { launched, closeRunScope } = yield* launchInRunScope(
            host,
            `agent-mismatched-${mismatch}`,
          );
          expect(Exit.isFailure(launched)).toBe(true);
          expect(fake.callerPaneLive()).toBe(true);
          expect(fake.closedPanes).toEqual([]);
          expect(fake.cleanupAuthorizations()).toBe(0);
          expect(Exit.isFailure(yield* closeRunScope)).toBe(true);
        }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
      }
    }),
  );

  it.live("skips a quarantined anchor without adopting restored-looking evidence", () => {
    const fake = fakeTopology();
    const scenario = Effect.gen(function* () {
      const host = yield* HerdrHost;
      const first = yield* launchRun(host, "agent-anchor-first");
      const anchor = yield* launchRun(host, "agent-anchor-second");
      const exact = fake.agents.get(anchor.paneId)!;
      fake.agents.set(anchor.paneId, {
        ...exact,
        agentSession: { ...exact.agentSession!, value: "native-anchor-replacement" },
      });
      expect(yield* anchor.inspect.pipe(Effect.flip)).toMatchObject({
        code: "herdr_ownership_mismatch",
      });
      fake.agents.set(anchor.paneId, exact);
      const next = yield* launchRun(host, "agent-after-quarantined-anchor");
      expect(fake.splitTargets()).toEqual([fake.callerPaneId, first.paneId, first.paneId]);
      expect(yield* first.inspect).toMatchObject({ paneId: first.paneId });
      yield* next.close;
      yield* first.close;
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
    return Effect.gen(function* () {
      expect(Exit.isFailure(yield* scenario.pipe(Effect.exit))).toBe(true);
    });
  });

  it.live("does not close a foreign pane returned by split", () => {
    const fake = fakeTopology();
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const first = yield* launchRun(host, "agent-owned-before-foreign-split");
      fake.inject("splitReturnsForeignPane");
      const { launched: second, closeRunScope } = yield* launchInRunScope(
        host,
        "agent-foreign-split",
      );
      expect(Exit.isFailure(second)).toBe(true);
      expect(fake.closedPanes).toEqual([]);
      expect(yield* first.inspect).toMatchObject({ paneId: first.paneId });
      expect(Exit.isFailure(yield* closeRunScope)).toBe(true);
      yield* first.close;
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live("rejects a globally colliding agent name before start and safely rolls back", () => {
    const fake = fakeTopology();
    fake.inject("agentNameCollision");
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const result = yield* Effect.result(launchRun(host, "agent-name-collision"));
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "herdr_agent_name_unavailable" },
      });
      expect(fake.closedPanes).toEqual(["user:p1"]);
      expect(fake.callerPaneLive()).toBe(true);
      expect(fake.cleanupAuthorizations()).toBe(1);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live("withholds cleanup authorization when an agent-name selector escapes closure", () => {
    const fake = fakeTopology();
    const scenario = Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* launchRun(host, "agent-escaped-selector");
      fake.inject("escapeAgentSelectorAfterClose");
      const failure = yield* hosted.close.pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "herdr_cleanup_unconfirmed" });
      expect(fake.closedPanes).toEqual([hosted.paneId]);
      expect(fake.callerPaneLive()).toBe(true);
      expect(fake.cleanupAuthorizations()).toBe(0);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
    return Effect.gen(function* () {
      expect(Exit.isFailure(yield* scenario.pipe(Effect.exit))).toBe(true);
    });
  });

  it.live("quarantines a provisional pane when its caller tab identity changes after split", () => {
    const fake = fakeTopology();
    fake.inject("replaceOriginalTabBeforeActivation");
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const initialFocus = fake.focusedTopology();
      const { launched, closeRunScope } = yield* launchInRunScope(
        host,
        "agent-replaced-caller-tab",
      );
      expect(Exit.isFailure(launched)).toBe(true);
      expect(fake.focusedTopology()).toEqual(initialFocus);
      expect(fake.closedPanes).toEqual([]);
      expect(fake.callerPaneLive()).toBe(true);
      expect(Exit.isFailure(yield* closeRunScope)).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live("does not quarantine committed runs when the user switches tabs", () => {
    const fake = fakeTopology();
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* launchRun(host, "agent-tab-switch");
      fake.switchToOtherTab();
      expect(yield* hosted.inspect).toMatchObject({ paneId: hosted.paneId });
      expect(yield* hosted.prompt("continue inspection")).toMatchObject({ paneId: hosted.paneId });
      const switchedFocus = fake.focusedTopology();
      yield* hosted.close;
      expect(fake.focusedTopology()).toEqual(switchedFocus);
      expect(fake.closedPanes).toEqual([hosted.paneId]);
      expect(fake.callerPaneLive()).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live("retries focus-free pane input after the user switches tabs", () => {
    const fake = fakeTopology();
    fake.inject("switchFocusAfterFirstProbe");
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* launchRun(host, "agent-focus-between-probes");
      expect(fake.activationConfirmations.get(hosted.paneId)).toBe(2);
      expect(fake.paneCommands.map(({ operation }) => operation).slice(0, 2)).toEqual([
        "activate pane input",
        "activate pane input",
      ]);
      expect(fake.focusedTopology()).toEqual({
        workspaceId: "user",
        tabId: "user:other",
        paneId: undefined,
      });
      yield* hosted.close;
      expect(fake.focusedTopology()).toEqual({
        workspaceId: "user",
        tabId: "user:other",
        paneId: undefined,
      });
      expect(fake.closedPanes).toEqual([hosted.paneId]);
      expect(fake.callerPaneLive()).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });
});
