// Test entry point composes the subject Layer once.
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { provideBuiltLayer } from "pi-cosmic-core";
import { HerdrHost } from "../src/boundary/herdr-host.ts";
import {
  fakeTopology,
  hostLayer,
  launch,
  launchInRunScope,
  launchRun,
  supervisor,
} from "./fixtures/herdr-host-fixture.ts";

describe("session-owned Herdr topology", () => {
  it.live(
    "splits the calling pane first, then the newest owned pane, and closes only owned panes",
    () => {
      const fake = fakeTopology();
      return Effect.gen(function* () {
        const host = yield* HerdrHost;
        const initialFocus = fake.focusedTopology();
        const first = yield* launchRun(host, "agent-1");
        const second = yield* launchRun(host, "agent-2");
        expect(first.workspaceId).toBe(second.workspaceId);
        expect(first.tabId).toBe(second.tabId);
        expect(first.paneId).not.toBe(second.paneId);
        expect(fake.splitTargets()).toEqual([fake.callerPaneId, first.paneId]);
        expect(first.agentName).toMatch(/^[a-z][a-z0-9_-]{0,31}$/u);
        expect(second.agentName).toMatch(/^[a-z][a-z0-9_-]{0,31}$/u);
        expect(first.agentName).not.toBe(second.agentName);
        expect(fake.activationConfirmations).toEqual(
          new Map([
            [first.paneId, 2],
            [second.paneId, 2],
          ]),
        );
        expect(fake.shellInspectedPanes).toEqual(new Set([first.paneId, second.paneId]));
        expect(fake.focusedTopology()).toEqual(initialFocus);

        yield* first.close;
        expect(fake.closedPanes).toEqual([first.paneId]);
        expect(fake.cleanupAuthorizations()).toBe(1);
        expect(fake.focusedTopology()).toEqual(initialFocus);
        yield* second.close;
        expect(fake.closedPanes).toEqual([first.paneId, second.paneId]);
        expect(fake.callerPaneLive()).toBe(true);
        expect(fake.cleanupAuthorizations()).toBe(2);
        expect(fake.focusedTopology()).toEqual(initialFocus);
      }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
    },
  );

  it.live("rejects an unresolvable calling pane before splitting", () => {
    const fake = fakeTopology();
    fake.inject("currentPaneMismatch");
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const { launched, closeRunScope } = yield* launchInRunScope(host, "agent-no-caller");
      expect(Exit.isFailure(launched)).toBe(true);
      expect(fake.splitCalls()).toBe(0);
      expect(fake.closedPanes).toEqual([]);
      expect(fake.callerPaneLive()).toBe(true);
      expect(Exit.isSuccess(yield* closeRunScope)).toBe(true);
      expect(fake.cleanupAuthorizations()).toBe(0);
      expect(fake.harnessCleanups()).toBe(1);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live("interrupts pre-topology acquisition and removes the still-authorized harness", () => {
    const fake = fakeTopology();
    fake.blockSnapshotBeforeSplit();
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const runScope = yield* Scope.make();
      const launching = yield* host
        .launch("pi", launch("agent-interrupted-before-split"), supervisor)
        .pipe(Effect.provideService(Scope.Scope, runScope), Effect.forkScoped);
      yield* fake.awaitBlockedPreSplitSnapshot();
      yield* Fiber.interrupt(launching);
      const interrupted = yield* Fiber.join(launching).pipe(Effect.exit);
      expect(Exit.isFailure(interrupted)).toBe(true);
      expect(fake.splitCalls()).toBe(0);
      expect(fake.cleanupWithholds()).toBe(0);
      expect(Exit.isSuccess(yield* Scope.close(runScope, Exit.void).pipe(Effect.exit))).toBe(true);
      expect(fake.harnessCleanups()).toBe(1);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live("interrupts after split, rolls back, and reauthorizes harness cleanup", () => {
    const fake = fakeTopology();
    fake.blockSnapshotAfterSplit();
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const runScope = yield* Scope.make();
      const launching = yield* host
        .launch("pi", launch("agent-interrupted-after-split"), supervisor)
        .pipe(Effect.provideService(Scope.Scope, runScope), Effect.forkScoped);
      yield* fake.awaitBlockedPostSplitSnapshot();
      yield* Fiber.interrupt(launching);
      const interrupted = yield* Fiber.join(launching).pipe(Effect.exit);
      expect(Exit.isFailure(interrupted)).toBe(true);
      if (Exit.isFailure(interrupted)) expect(Cause.hasInterrupts(interrupted.cause)).toBe(true);
      expect(fake.splitCalls()).toBe(1);
      expect(fake.closedPanes).toEqual(["user:p1"]);
      expect(fake.cleanupWithholds()).toBe(1);
      expect(fake.cleanupAuthorizations()).toBe(1);
      expect(Exit.isSuccess(yield* Scope.close(runScope, Exit.void).pipe(Effect.exit))).toBe(true);
      expect(fake.harnessCleanups()).toBe(1);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live("uses the newest remaining owned pane after the latest pane closes", () => {
    const fake = fakeTopology();
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const first = yield* launchRun(host, "anchor-first");
      const second = yield* launchRun(host, "anchor-second");
      const third = yield* launchRun(host, "anchor-third");
      yield* third.close;
      const fourth = yield* launchRun(host, "anchor-fourth");
      expect(fake.splitTargets()).toEqual([
        fake.callerPaneId,
        first.paneId,
        second.paneId,
        second.paneId,
      ]);
      yield* fourth.close;
      yield* second.close;
      yield* first.close;
      expect(fake.callerPaneLive()).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live("generates distinct Herdr 0.8-safe names for every hosted runtime", () => {
    const fake = fakeTopology();
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const names: string[] = [];
      for (const runtime of ["pi", "claude", "codex"] as const) {
        const runId = `agent-${runtime}-with-a-long-ownership-identifier`;
        const hosted = yield* launchRun(host, runId, runtime);
        expect(hosted.agentName).toMatch(/^[a-z][a-z0-9_-]{0,31}$/u);
        names.push(hosted.agentName);
        yield* hosted.close;
      }
      expect(new Set(names).size).toBe(3);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live("launches from private pane-command receipts without terminal-output attestation", () => {
    const fake = fakeTopology();
    fake.executeFirstActivationReceipt();
    fake.inject("validSecretBootstrap");
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* launchRun(host, "agent-receipt-only");
      expect(fake.publishedReceipts).toEqual(
        new Set([
          "activation-1",
          "environment-ready",
          "post-environment-shell",
          "secret-ready",
          "post-secret-shell",
        ]),
      );
      expect(fake.paneCommands.map(({ operation }) => operation)).toEqual([
        "activate pane input",
        "prepare pane environment",
        "confirm pane shell",
        "load pane secrets",
        "confirm pane shell",
      ]);
      expect(yield* hosted.inspect).toMatchObject({ paneId: hosted.paneId });
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live("waits for a transient native pane occupant before spending activation probes", () => {
    const fake = fakeTopology();
    fake.delayInitialShellReadiness(3);
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* launchRun(host, "agent-delayed-shell");
      expect(fake.shellProcessInspections.get(hosted.paneId)).toBeGreaterThanOrEqual(5);
      expect(fake.activationConfirmations.get(hosted.paneId)).toBe(2);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live("waits for stale post-activation agent detection before environment input", () => {
    const fake = fakeTopology();
    fake.delayPostActivationAgentClearance(4);
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* launchRun(host, "agent-post-activation-detection", "claude");
      expect(fake.shellProcessInspections.get(hosted.paneId)).toBeGreaterThanOrEqual(4);
      expect(fake.paneCommands).toContainEqual({
        paneId: hosted.paneId,
        operation: "prepare pane environment",
      });
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live("rolls back when both harmless pane-input activation probes are dropped", () => {
    const fake = fakeTopology();
    fake.inject("dropAllActivationProbes");
    fake.inject("validSecretBootstrap");
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const initialFocus = fake.focusedTopology();
      const result = yield* Effect.result(launchRun(host, "agent-activation-failure"));
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          code: "herdr_pane_input_unavailable",
          message: expect.stringContaining(
            "Neither harmless activation attempt published its private receipt",
          ),
        },
      });
      expect(fake.activationConfirmations.get("user:p1")).toBe(2);
      expect(fake.paneCommands.map(({ operation }) => operation)).toEqual([
        "activate pane input",
        "activate pane input",
      ]);
      expect(fake.closedPanes).toEqual(["user:p1"]);
      expect(fake.callerPaneLive()).toBe(true);
      expect(fake.cleanupAuthorizations()).toBe(1);
      expect(fake.focusedTopology()).toEqual(initialFocus);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live("blocks agent start and safely cleans up after an invalid environment receipt", () => {
    const fake = fakeTopology();
    fake.executeFirstActivationReceipt();
    fake.failReceipt("environment-ready", "wrong");
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const failure = yield* launchRun(host, "agent-invalid-environment-receipt").pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "herdr_startup_receipt_invalid" });
      expect(fake.agents.size).toBe(0);
      expect(fake.paneCommands.map(({ operation }) => operation)).toEqual([
        "activate pane input",
        "prepare pane environment",
      ]);
      expect(fake.closedPanes).toEqual(["user:p1"]);
      expect(fake.cleanupWithholds()).toBe(1);
      expect(fake.cleanupAuthorizations()).toBe(1);
      expect(fake.callerPaneLive()).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live("does not override newer user focus during focus-free receipt retry and rollback", () => {
    const fake = fakeTopology();
    fake.inject("dropAllActivationProbes");
    fake.inject("switchFocusAfterFirstProbe");
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const result = yield* Effect.result(launchRun(host, "agent-newer-user-focus"));
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "herdr_pane_input_unavailable" },
      });
      expect(fake.focusedTopology()).toEqual({
        workspaceId: "user",
        tabId: "user:other",
        paneId: undefined,
      });
      expect(fake.closedPanes).toEqual(["user:p1"]);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live("rolls back a confirmed pre-application agent_pane_busy rejection", () => {
    const fake = fakeTopology();
    fake.inject("rejectStartAsBusy");
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const initialFocus = fake.focusedTopology();
      const result = yield* Effect.result(launchRun(host, "agent-pane-busy"));
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "agent_pane_busy" },
      });
      expect(fake.closedPanes).toEqual(["user:p1"]);
      expect(fake.callerPaneLive()).toBe(true);
      expect(fake.cleanupAuthorizations()).toBe(1);
      expect(fake.focusedTopology()).toEqual(initialFocus);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live("launches into the exact caller tab while another tab remains focused", () => {
    const fake = fakeTopology();
    fake.switchToOtherTab();
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const initialFocus = fake.focusedTopology();
      const hosted = yield* launchRun(host, "agent-unfocused-target");
      expect(hosted.tabId).toBe("user:t");
      expect(fake.focusedTopology()).toEqual(initialFocus);
      yield* hosted.close;
      expect(fake.closedPanes).toEqual([hosted.paneId]);
      expect(fake.focusedTopology()).toEqual(initialFocus);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live("closes a focused owned pane without issuing a focus command", () => {
    const fake = fakeTopology();
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* host.launch(
        "pi",
        { ...launch("agent-focused-close"), closeOnReport: true },
        supervisor,
      );
      fake.focusPaneAsUser(hosted.paneId);
      expect(fake.focusedTopology()).toEqual({
        workspaceId: "user",
        tabId: "user:t",
        paneId: hosted.paneId,
      });
      yield* hosted.close;
      expect(fake.closedPanes).toEqual([hosted.paneId]);
      expect(fake.focusedTopology()).toEqual({
        workspaceId: "user",
        tabId: "user:t",
        paneId: fake.callerPaneId,
      });
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live("quarantines startup when native-session identity is not returned atomically", () => {
    const fake = fakeTopology();
    fake.inject("omitAgentSession");
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const { launched, closeRunScope } = yield* launchInRunScope(
        host,
        "agent-session-unconfirmed",
      );
      expect(yield* Effect.flip(launched)).toMatchObject({
        code: "herdr_cleanup_unconfirmed",
        message: expect.stringContaining("supported Herdr protocol exposes no launch token"),
      });
      expect(Exit.isFailure(yield* closeRunScope)).toBe(true);
      expect(fake.cleanupWithholds()).toBe(1);
      expect(fake.cleanupAuthorizations()).toBe(0);
      expect(fake.harnessCleanups()).toBe(0);
      expect(fake.closedPanes).toEqual([]);
      expect(fake.callerPaneLive()).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
  });

  it.live(
    "rejects a secret bootstrap without matching attestation before topology mutation",
    () => {
      const fake = fakeTopology();
      fake.inject("invalidSecretAttestation");
      return Effect.gen(function* () {
        const host = yield* HerdrHost;
        const failure = yield* launchRun(host, "agent-invalid-secret").pipe(Effect.flip);
        expect(failure).toMatchObject({
          code: "herdr_secret_attestation_invalid",
        });
        expect(fake.closedPanes).toEqual([]);
        expect(fake.callerPaneLive()).toBe(true);
        expect(fake.cleanupAuthorizations()).toBe(1);
      }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
    },
  );

  it.live(
    "fails scope close and withholds harness cleanup after an applied uncertain start",
    () => {
      const fake = fakeTopology();
      fake.failAppliedStartAndRollbackSnapshot();
      return Effect.gen(function* () {
        const host = yield* HerdrHost;
        const { launched, closeRunScope } = yield* launchInRunScope(host, "agent-uncertain");
        expect(Exit.isFailure(launched)).toBe(true);
        expect(Exit.isFailure(yield* closeRunScope)).toBe(true);
        expect(fake.cleanupWithholds()).toBe(1);
        expect(fake.cleanupAuthorizations()).toBe(0);
        expect(fake.harnessCleanups()).toBe(0);
        expect(fake.closedPanes).toEqual([]);
        expect(fake.callerPaneLive()).toBe(true);
      }).pipe(Effect.scoped, provideBuiltLayer(hostLayer(fake)));
    },
  );
});
