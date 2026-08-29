// Test entry point composes the subject Layer once.
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { provideBuiltLayer } from "pi-cosmic-core";
import { HerdrCli } from "../src/boundary/herdr-cli.ts";
import { HerdrHarness } from "../src/boundary/herdr-harness.ts";
import { HerdrHost } from "../src/boundary/herdr-host.ts";
import { fakeTopology, launch, supervisor } from "./fixtures/herdr-host-fixture.ts";

describe("Herdr launch ownership hardening", () => {
  it.live("keeps a committed run quarantined after restored-looking ownership evidence", () => {
    const fake = fakeTopology();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    const scenario = Effect.gen(function* () {
      const host = yield* HerdrHost;
      const initialFocus = fake.focusedTopology();
      const hosted = yield* host.launch("pi", launch("agent-committed-mismatch"), {
        ...supervisor,
        runId: "agent-committed-mismatch",
      });
      const exact = fake.agents.get(hosted.paneId)!;
      fake.agents.set(hosted.paneId, {
        ...exact,
        agentSession: { ...exact.agentSession!, value: "native-restored-unowned" },
        nativeSession: "native-restored-unowned",
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
      expect(fake.focusOperations).toEqual([]);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
    return Effect.gen(function* () {
      expect(Exit.isFailure(yield* scenario.pipe(Effect.exit))).toBe(true);
    });
  });

  it.live("never retries an outcome-uncertain committed close", () => {
    const fake = fakeTopology();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    const scenario = Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* host.launch("pi", launch("agent-uncertain-close"), {
        ...supervisor,
        runId: "agent-uncertain-close",
      });
      fake.failPaneCloseAfterApplying();
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
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
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    const scenario = Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* host.launch("pi", launch("agent-last-pane"), {
        ...supervisor,
        runId: "agent-last-pane",
      });
      fake.removeCallerPane();
      expect(yield* hosted.close.pipe(Effect.flip)).toMatchObject({
        code: "herdr_ownership_mismatch",
        message: expect.stringContaining("last visible pane"),
      });
      expect(fake.closedPanes).toEqual([]);
      expect(fake.cleanupAuthorizations()).toBe(0);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
    return Effect.gen(function* () {
      expect(Exit.isFailure(yield* scenario.pipe(Effect.exit))).toBe(true);
    });
  });

  it.live("commits close ownership before observing interruption", () => {
    const fake = fakeTopology();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* host.launch("pi", launch("agent-interrupted-close"), {
        ...supervisor,
        runId: "agent-interrupted-close",
      });
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
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.live("quarantines terminal drift without changing focus", () => {
    const fake = fakeTopology();
    fake.switchToOtherTab();
    fake.replaceTerminalOnFirstShellInspection();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const initialFocus = fake.focusedTopology();
      const runScope = yield* Scope.make();
      const launched = yield* host
        .launch("pi", launch("agent-replaced-terminal"), {
          ...supervisor,
          runId: "agent-replaced-terminal",
        })
        .pipe(Effect.provideService(Scope.Scope, runScope), Effect.exit);
      expect(Exit.isFailure(launched)).toBe(true);
      expect(fake.paneCommands).toEqual([]);
      expect(fake.cleanupAuthorizations()).toBe(0);
      expect(fake.focusedTopology()).toEqual(initialFocus);
      expect(fake.focusOperations).toEqual([]);
      expect(Exit.isFailure(yield* Scope.close(runScope, Exit.void).pipe(Effect.exit))).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.live("quarantines terminal drift observed after activation attestation", () => {
    const fake = fakeTopology();
    fake.driftAfterMarker("confirm pane input");
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const runScope = yield* Scope.make();
      const launched = yield* host
        .launch("pi", launch("agent-post-activation-drift"), {
          ...supervisor,
          runId: "agent-post-activation-drift",
        })
        .pipe(Effect.provideService(Scope.Scope, runScope), Effect.exit);
      expect(Exit.isFailure(launched)).toBe(true);
      expect(fake.paneCommands.map(({ operation }) => operation)).toEqual([
        "activate pane input",
        "activate pane input",
      ]);
      expect(fake.callerPaneLive()).toBe(true);
      expect(fake.cleanupAuthorizations()).toBe(0);
      expect(Exit.isFailure(yield* Scope.close(runScope, Exit.void).pipe(Effect.exit))).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.live("quarantines terminal drift observed after environment attestation", () => {
    const fake = fakeTopology();
    fake.enableSecretBootstrap();
    fake.driftAfterMarker("confirm pane environment");
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const runScope = yield* Scope.make();
      const launched = yield* host
        .launch("pi", launch("agent-pre-secret-drift"), {
          ...supervisor,
          runId: "agent-pre-secret-drift",
        })
        .pipe(Effect.provideService(Scope.Scope, runScope), Effect.exit);
      expect(Exit.isFailure(launched)).toBe(true);
      expect(fake.paneCommands.map(({ operation }) => operation)).toEqual([
        "activate pane input",
        "activate pane input",
        "prepare pane environment",
      ]);
      expect(fake.callerPaneLive()).toBe(true);
      expect(fake.cleanupAuthorizations()).toBe(0);
      expect(Exit.isFailure(yield* Scope.close(runScope, Exit.void).pipe(Effect.exit))).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.live("re-proves foreground-shell readiness before secret bootstrap", () => {
    const fake = fakeTopology();
    fake.enableSecretBootstrap();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* host.launch("pi", launch("agent-secret-shell"), {
        ...supervisor,
        runId: "agent-secret-shell",
      });
      expect(fake.paneCommands.map(({ operation }) => operation)).toEqual([
        "activate pane input",
        "activate pane input",
        "prepare pane environment",
        "confirm pane shell",
        "load pane secrets",
        "confirm pane shell",
      ]);
      expect(fake.shellProcessInspections.get(hosted.paneId)).toBeGreaterThanOrEqual(3);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.live("rejects duplicate caller workspace, tab, and terminal selectors before splitting", () =>
    Effect.gen(function* () {
      for (const selector of ["workspace", "tab", "terminal"] as const) {
        const fake = fakeTopology();
        fake.injectDuplicateSelector(selector);
        const layer = HerdrHost.layer.pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(HerdrCli, fake.cli),
              Layer.succeed(HerdrHarness, fake.harness),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const host = yield* HerdrHost;
          const runScope = yield* Scope.make();
          const launched = yield* host
            .launch("pi", launch(`agent-duplicate-${selector}`), {
              ...supervisor,
              runId: `agent-duplicate-${selector}`,
            })
            .pipe(Effect.provideService(Scope.Scope, runScope), Effect.exit);
          expect(Exit.isFailure(launched)).toBe(true);
          expect(fake.splitCalls()).toBe(0);
          expect(fake.paneCommands).toEqual([]);
          expect(fake.closedPanes).toEqual([]);
          expect(fake.callerPaneLive()).toBe(true);
          expect(fake.cleanupAuthorizations()).toBe(0);
          expect(Exit.isSuccess(yield* Scope.close(runScope, Exit.void).pipe(Effect.exit))).toBe(
            true,
          );
          expect(fake.cleanupAuthorizations()).toBe(0);
          expect(fake.harnessCleanups()).toBe(1);
        }).pipe(Effect.scoped, provideBuiltLayer(layer));
      }
    }),
  );

  it.live("quarantines mismatched process-info, start-response, and post-start name evidence", () =>
    Effect.gen(function* () {
      for (const mismatch of ["process", "start", "name"] as const) {
        const fake = fakeTopology();
        if (mismatch === "process") fake.returnWrongProcessInfoPane();
        if (mismatch === "start") fake.returnMismatchedStartedAgent();
        if (mismatch === "name") fake.duplicateAgentNameAfterStart();
        const layer = HerdrHost.layer.pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(HerdrCli, fake.cli),
              Layer.succeed(HerdrHarness, fake.harness),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const host = yield* HerdrHost;
          const runScope = yield* Scope.make();
          const launched = yield* host
            .launch("pi", launch(`agent-mismatched-${mismatch}`), {
              ...supervisor,
              runId: `agent-mismatched-${mismatch}`,
            })
            .pipe(Effect.provideService(Scope.Scope, runScope), Effect.exit);
          expect(Exit.isFailure(launched)).toBe(true);
          expect(fake.callerPaneLive()).toBe(true);
          expect(fake.closedPanes).toEqual([]);
          expect(fake.cleanupAuthorizations()).toBe(0);
          expect(Exit.isFailure(yield* Scope.close(runScope, Exit.void).pipe(Effect.exit))).toBe(
            true,
          );
        }).pipe(Effect.scoped, provideBuiltLayer(layer));
      }
    }),
  );

  it.live("skips a quarantined anchor without adopting restored-looking evidence", () => {
    const fake = fakeTopology();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    const scenario = Effect.gen(function* () {
      const host = yield* HerdrHost;
      const first = yield* host.launch("pi", launch("agent-anchor-first"), {
        ...supervisor,
        runId: "agent-anchor-first",
      });
      const anchor = yield* host.launch("pi", launch("agent-anchor-second"), {
        ...supervisor,
        runId: "agent-anchor-second",
      });
      const exact = fake.agents.get(anchor.paneId)!;
      fake.agents.set(anchor.paneId, {
        ...exact,
        agentSession: { ...exact.agentSession!, value: "native-anchor-replacement" },
        nativeSession: "native-anchor-replacement",
      });
      expect(yield* anchor.inspect.pipe(Effect.flip)).toMatchObject({
        code: "herdr_ownership_mismatch",
      });
      fake.agents.set(anchor.paneId, exact);
      const next = yield* host.launch("pi", launch("agent-after-quarantined-anchor"), {
        ...supervisor,
        runId: "agent-after-quarantined-anchor",
      });
      expect(fake.splitTargets()).toEqual([fake.callerPaneId, first.paneId, first.paneId]);
      expect(yield* first.inspect).toMatchObject({ paneId: first.paneId });
      yield* next.close;
      yield* first.close;
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
    return Effect.gen(function* () {
      expect(Exit.isFailure(yield* scenario.pipe(Effect.exit))).toBe(true);
    });
  });

  it.live("does not close a foreign pane returned by split", () => {
    const fake = fakeTopology();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const first = yield* host.launch("pi", launch("agent-owned-before-foreign-split"), {
        ...supervisor,
        runId: "agent-owned-before-foreign-split",
      });
      fake.returnForeignSplitPane();
      const runScope = yield* Scope.make();
      const second = yield* host
        .launch("pi", launch("agent-foreign-split"), {
          ...supervisor,
          runId: "agent-foreign-split",
        })
        .pipe(Effect.provideService(Scope.Scope, runScope), Effect.exit);
      expect(Exit.isFailure(second)).toBe(true);
      expect(fake.closedPanes).toEqual([]);
      expect(yield* first.inspect).toMatchObject({ paneId: first.paneId });
      expect(Exit.isFailure(yield* Scope.close(runScope, Exit.void).pipe(Effect.exit))).toBe(true);
      yield* first.close;
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.live("rejects a globally colliding agent name before start and safely rolls back", () => {
    const fake = fakeTopology();
    fake.injectAgentNameCollision();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const result = yield* Effect.result(
        host.launch("pi", launch("agent-name-collision"), {
          ...supervisor,
          runId: "agent-name-collision",
        }),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "herdr_agent_name_unavailable" },
      });
      expect(fake.closedPanes).toEqual(["user:p1"]);
      expect(fake.callerPaneLive()).toBe(true);
      expect(fake.cleanupAuthorizations()).toBe(1);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.live("withholds cleanup authorization when an agent-name selector escapes closure", () => {
    const fake = fakeTopology();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    const scenario = Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* host.launch("pi", launch("agent-escaped-selector"), {
        ...supervisor,
        runId: "agent-escaped-selector",
      });
      fake.escapeAgentNameAfterClose();
      const failure = yield* hosted.close.pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "herdr_cleanup_unconfirmed" });
      expect(fake.closedPanes).toEqual([hosted.paneId]);
      expect(fake.callerPaneLive()).toBe(true);
      expect(fake.cleanupAuthorizations()).toBe(0);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
    return Effect.gen(function* () {
      expect(Exit.isFailure(yield* scenario.pipe(Effect.exit))).toBe(true);
    });
  });

  it.live("quarantines a provisional pane when its caller tab identity changes after split", () => {
    const fake = fakeTopology();
    fake.replaceOriginalTabBeforeFirstActivation();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const initialFocus = fake.focusedTopology();
      const runScope = yield* Scope.make();
      const launched = yield* host
        .launch("pi", launch("agent-replaced-caller-tab"), {
          ...supervisor,
          runId: "agent-replaced-caller-tab",
        })
        .pipe(Effect.provideService(Scope.Scope, runScope), Effect.exit);
      expect(Exit.isFailure(launched)).toBe(true);
      expect(fake.focusOperations).toEqual([]);
      expect(fake.focusedTopology()).toEqual(initialFocus);
      expect(fake.closedPanes).toEqual([]);
      expect(fake.callerPaneLive()).toBe(true);
      expect(Exit.isFailure(yield* Scope.close(runScope, Exit.void).pipe(Effect.exit))).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.live("does not quarantine committed runs when the user switches tabs", () => {
    const fake = fakeTopology();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* host.launch("pi", launch("agent-tab-switch"), {
        ...supervisor,
        runId: "agent-tab-switch",
      });
      fake.switchToOtherTab();
      expect(yield* hosted.inspect).toMatchObject({ paneId: hosted.paneId });
      expect(yield* hosted.prompt("continue inspection")).toMatchObject({ paneId: hosted.paneId });
      const switchedFocus = fake.focusedTopology();
      yield* hosted.close;
      expect(fake.focusedTopology()).toEqual(switchedFocus);
      expect(fake.focusOperations).toEqual([]);
      expect(fake.closedPanes).toEqual([hosted.paneId]);
      expect(fake.callerPaneLive()).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.live("retries focus-free pane input after the user switches tabs", () => {
    const fake = fakeTopology();
    fake.switchToOtherTabAfterFirstProbe();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* host.launch("pi", launch("agent-focus-between-probes"), {
        ...supervisor,
        runId: "agent-focus-between-probes",
      });
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
      expect(fake.focusOperations).toEqual([]);
      yield* hosted.close;
      expect(fake.focusedTopology()).toEqual({
        workspaceId: "user",
        tabId: "user:other",
        paneId: undefined,
      });
      expect(fake.focusOperations).toEqual([]);
      expect(fake.closedPanes).toEqual([hosted.paneId]);
      expect(fake.callerPaneLive()).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });
});
