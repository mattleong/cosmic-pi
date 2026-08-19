// Test entry point composes the subject Layer once.
// @effect-diagnostics effect/strictEffectProvide:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HerdrCli } from "../src/boundary/herdr-cli.ts";
import { HerdrHarness } from "../src/boundary/herdr-harness.ts";
import { HerdrHost } from "../src/boundary/herdr-host.ts";
import { fakeTopology, launch, supervisor } from "./fixtures/herdr-host-fixture.ts";

describe("session-owned Herdr topology", () => {
  it.live(
    "splits the calling pane first, then the newest owned pane, and closes only owned panes",
    () => {
      const fake = fakeTopology();
      const layer = HerdrHost.layer.pipe(
        Layer.provide(
          Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
        ),
      );
      return Effect.gen(function* () {
        const host = yield* HerdrHost;
        const first = yield* host.launch("pi", launch("agent-1"), supervisor);
        const second = yield* host.launch("pi", launch("agent-2"), {
          ...supervisor,
          runId: "agent-2",
        });
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

        yield* first.close;
        expect(fake.closedPanes).toEqual([first.paneId]);
        expect(fake.cleanupAuthorizations()).toBe(1);
        yield* second.close;
        expect(fake.closedPanes).toEqual([first.paneId, second.paneId]);
        expect(fake.callerPaneLive()).toBe(true);
        expect(fake.cleanupAuthorizations()).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.live("rejects an unresolvable calling pane before splitting", () => {
    const fake = fakeTopology();
    fake.mismatchCurrentPane();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const runScope = yield* Scope.make();
      const launched = yield* host
        .launch("pi", launch("agent-no-caller"), {
          ...supervisor,
          runId: "agent-no-caller",
        })
        .pipe(Effect.provideService(Scope.Scope, runScope), Effect.exit);
      expect(Exit.isFailure(launched)).toBe(true);
      expect(fake.splitCalls()).toBe(0);
      expect(fake.closedPanes).toEqual([]);
      expect(fake.callerPaneLive()).toBe(true);
      expect(Exit.isSuccess(yield* Scope.close(runScope, Exit.void).pipe(Effect.exit))).toBe(true);
      expect(fake.cleanupAuthorizations()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("uses the newest remaining owned pane after the latest pane closes", () => {
    const fake = fakeTopology();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const first = yield* host.launch("pi", launch("anchor-first"), supervisor);
      const second = yield* host.launch("pi", launch("anchor-second"), {
        ...supervisor,
        runId: "anchor-second",
      });
      const third = yield* host.launch("pi", launch("anchor-third"), {
        ...supervisor,
        runId: "anchor-third",
      });
      yield* third.close;
      const fourth = yield* host.launch("pi", launch("anchor-fourth"), {
        ...supervisor,
        runId: "anchor-fourth",
      });
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
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("generates distinct Herdr 0.8-safe names for every hosted runtime", () => {
    const fake = fakeTopology();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const names: string[] = [];
      for (const runtime of ["pi", "claude", "codex"] as const) {
        const runId = `agent-${runtime}-with-a-long-ownership-identifier`;
        const hosted = yield* host.launch(runtime, launch(runId), {
          ...supervisor,
          runId,
        });
        expect(hosted.agentName).toMatch(/^[a-z][a-z0-9_-]{0,31}$/u);
        names.push(hosted.agentName);
        yield* hosted.close;
      }
      expect(new Set(names).size).toBe(3);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("waits for a transient native pane occupant before spending activation probes", () => {
    const fake = fakeTopology();
    fake.delayInitialShellReadiness(3);
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* host.launch("pi", launch("agent-delayed-shell"), {
        ...supervisor,
        runId: "agent-delayed-shell",
      });
      expect(fake.shellProcessInspections.get(hosted.paneId)).toBeGreaterThanOrEqual(5);
      expect(fake.activationConfirmations.get(hosted.paneId)).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("waits for stale post-activation agent detection before environment input", () => {
    const fake = fakeTopology();
    fake.delayPostActivationAgentClearance(4);
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* host.launch("claude", launch("agent-post-activation-detection"), {
        ...supervisor,
        runId: "agent-post-activation-detection",
      });
      expect(fake.shellProcessInspections.get(hosted.paneId)).toBeGreaterThanOrEqual(4);
      expect(fake.paneCommands).toContainEqual({
        paneId: hosted.paneId,
        operation: "prepare pane environment",
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("rolls back when both harmless pane-input activation probes are dropped", () => {
    const fake = fakeTopology();
    fake.dropEveryActivationProbe();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const result = yield* Effect.result(
        host.launch("pi", launch("agent-activation-failure"), {
          ...supervisor,
          runId: "agent-activation-failure",
        }),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "herdr_pane_input_unavailable" },
      });
      expect(fake.activationConfirmations.get("user:p1")).toBe(2);
      expect(fake.closedPanes).toEqual(["user:p1"]);
      expect(fake.callerPaneLive()).toBe(true);
      expect(fake.cleanupAuthorizations()).toBe(1);
      expect(fake.focusedTab()).toBe("user:t");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("does not restore stale focus after rollback closes the owned pane", () => {
    const fake = fakeTopology();
    fake.dropEveryActivationProbe();
    fake.moveFocusToOtherOnPaneClose();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      yield* Effect.result(
        host.launch("pi", launch("agent-newer-user-focus"), {
          ...supervisor,
          runId: "agent-newer-user-focus",
        }),
      );
      expect(fake.focusedTab()).toBe("user:other");
      expect(fake.focusOperations.filter((operation) => operation === "restore focus")).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("rolls back a confirmed pre-application agent_pane_busy rejection", () => {
    const fake = fakeTopology();
    fake.rejectStartWithPaneBusy();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const result = yield* Effect.result(
        host.launch("pi", launch("agent-pane-busy"), {
          ...supervisor,
          runId: "agent-pane-busy",
        }),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "agent_pane_busy" },
      });
      expect(fake.closedPanes).toEqual(["user:p1"]);
      expect(fake.callerPaneLive()).toBe(true);
      expect(fake.cleanupAuthorizations()).toBe(1);
      expect(fake.focusedTab()).toBe("user:t");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("rolls back before committing a run when focus restoration fails", () => {
    const fake = fakeTopology();
    fake.switchToOtherTab();
    fake.failRestoreFocus();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const result = yield* Effect.result(
        host.launch("pi", launch("agent-focus-failure"), {
          ...supervisor,
          runId: "agent-focus-failure",
        }),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "herdr_restore_focus_outcome_uncertain" },
      });
      expect(fake.closedPanes).toEqual(["user:p1"]);
      expect(fake.callerPaneLive()).toBe(true);
      expect(fake.cleanupAuthorizations()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("quarantines startup when native-session identity is not returned atomically", () => {
    const fake = fakeTopology();
    fake.omitNativeSession();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const runScope = yield* Scope.make();
      const failure = yield* host
        .launch("pi", launch("agent-session-unconfirmed"), {
          ...supervisor,
          runId: "agent-session-unconfirmed",
        })
        .pipe(Effect.provideService(Scope.Scope, runScope), Effect.flip);
      expect(failure).toMatchObject({
        code: "herdr_cleanup_unconfirmed",
        message: expect.stringContaining("protocol 19 exposes no launch token"),
      });
      const closed = yield* Scope.close(runScope, Exit.void).pipe(Effect.exit);
      expect(Exit.isFailure(closed)).toBe(true);
      expect(fake.cleanupAuthorizations()).toBe(0);
      expect(fake.closedPanes).toEqual([]);
      expect(fake.callerPaneLive()).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live(
    "rejects a secret bootstrap without matching attestation before topology mutation",
    () => {
      const fake = fakeTopology();
      fake.invalidateSecretAttestation();
      const layer = HerdrHost.layer.pipe(
        Layer.provide(
          Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
        ),
      );
      return Effect.gen(function* () {
        const host = yield* HerdrHost;
        const failure = yield* host
          .launch("pi", launch("agent-invalid-secret"), {
            ...supervisor,
            runId: "agent-invalid-secret",
          })
          .pipe(Effect.flip);
        expect(failure).toMatchObject({
          code: "herdr_secret_attestation_invalid",
        });
        expect(fake.closedPanes).toEqual([]);
        expect(fake.callerPaneLive()).toBe(true);
        expect(fake.cleanupAuthorizations()).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.live(
    "fails scope close and withholds harness cleanup after an applied uncertain start",
    () => {
      const fake = fakeTopology();
      fake.failAppliedStartAndRollbackSnapshot();
      const layer = HerdrHost.layer.pipe(
        Layer.provide(
          Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
        ),
      );
      return Effect.gen(function* () {
        const host = yield* HerdrHost;
        const runScope = yield* Scope.make();
        const launched = yield* host
          .launch("pi", launch("agent-uncertain"), {
            ...supervisor,
            runId: "agent-uncertain",
          })
          .pipe(Effect.provideService(Scope.Scope, runScope), Effect.exit);
        expect(Exit.isFailure(launched)).toBe(true);
        const closed = yield* Scope.close(runScope, Exit.void).pipe(Effect.exit);
        expect(Exit.isFailure(closed)).toBe(true);
        expect(fake.cleanupAuthorizations()).toBe(0);
        expect(fake.closedPanes).toEqual([]);
        expect(fake.callerPaneLive()).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );
});
