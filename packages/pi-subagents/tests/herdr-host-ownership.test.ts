// Test entry point composes the subject Layer once.
// @effect-diagnostics effect/strictEffectProvide:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
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
      expect(fake.closedWorkspaces()).toBe(0);
      expect(fake.cleanupAuthorizations()).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer));
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
      fake.failWorkspaceCloseAfterApplying();
      expect(yield* hosted.close.pipe(Effect.flip)).toMatchObject({
        code: "herdr_close_workspace_outcome_uncertain",
      });
      expect(yield* hosted.close.pipe(Effect.flip)).toMatchObject({
        code: "herdr_ownership_mismatch",
        message: expect.stringContaining("quarantined"),
      });
      expect(fake.closedWorkspaces()).toBe(1);
      expect(fake.cleanupAuthorizations()).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer));
    return Effect.gen(function* () {
      expect(Exit.isFailure(yield* scenario.pipe(Effect.exit))).toBe(true);
      expect(fake.closedWorkspaces()).toBe(1);
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
      fake.blockSnapshotAfterWorkspaceClose();
      const closing = yield* hosted.close.pipe(Effect.forkScoped);
      yield* fake.awaitBlockedPostCloseSnapshot();
      const interrupting = yield* Fiber.interrupt(closing).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      fake.releaseBlockedPostCloseSnapshot();
      yield* Fiber.join(interrupting);
      expect(fake.closedWorkspaces()).toBe(1);
      expect(fake.cleanupAuthorizations()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("quarantines a pane whose terminal identity changes during shell readiness", () => {
    const fake = fakeTopology();
    fake.replaceTerminalOnFirstShellInspection();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
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
      expect(Exit.isFailure(yield* Scope.close(runScope, Exit.void).pipe(Effect.exit))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("quarantines terminal drift observed after activation focus and before input", () => {
    const fake = fakeTopology();
    fake.driftAfterFocus();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const runScope = yield* Scope.make();
      const launched = yield* host
        .launch("pi", launch("agent-post-focus-drift"), {
          ...supervisor,
          runId: "agent-post-focus-drift",
        })
        .pipe(Effect.provideService(Scope.Scope, runScope), Effect.exit);
      expect(Exit.isFailure(launched)).toBe(true);
      expect(fake.paneCommands).toEqual([]);
      expect(fake.closedWorkspaces()).toBe(0);
      expect(fake.cleanupAuthorizations()).toBe(0);
      expect(Exit.isFailure(yield* Scope.close(runScope, Exit.void).pipe(Effect.exit))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer));
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
      expect(fake.closedWorkspaces()).toBe(0);
      expect(fake.cleanupAuthorizations()).toBe(0);
      expect(Exit.isFailure(yield* Scope.close(runScope, Exit.void).pipe(Effect.exit))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer));
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
      expect(fake.closedWorkspaces()).toBe(0);
      expect(fake.cleanupAuthorizations()).toBe(0);
      expect(Exit.isFailure(yield* Scope.close(runScope, Exit.void).pipe(Effect.exit))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer));
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
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("quarantines duplicate workspace, tab, and terminal selector identities", () =>
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
          expect(fake.paneCommands).toEqual([]);
          expect(fake.closedWorkspaces()).toBe(0);
          expect(fake.cleanupAuthorizations()).toBe(0);
          expect(Exit.isFailure(yield* Scope.close(runScope, Exit.void).pipe(Effect.exit))).toBe(
            true,
          );
        }).pipe(Effect.scoped, Effect.provide(layer));
      }
    }),
  );

  it.live("quarantines mismatched process-info, start-response, and post-start name evidence", () =>
    Effect.gen(function* () {
      for (const mismatch of ["process", "start", "name", "focus"] as const) {
        const fake = fakeTopology();
        if (mismatch === "process") fake.returnWrongProcessInfoPane();
        if (mismatch === "start") fake.returnMismatchedStartedAgent();
        if (mismatch === "name") fake.duplicateAgentNameAfterStart();
        if (mismatch === "focus") fake.driftDuringFocusRestoration();
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
          expect(fake.closedWorkspaces()).toBe(0);
          expect(fake.closedPanes).toEqual([]);
          expect(fake.cleanupAuthorizations()).toBe(0);
          expect(Exit.isFailure(yield* Scope.close(runScope, Exit.void).pipe(Effect.exit))).toBe(
            true,
          );
        }).pipe(Effect.scoped, Effect.provide(layer));
      }
    }),
  );

  it.live("refuses to split a quarantined committed anchor after ABA-looking restoration", () => {
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
      expect(fake.splitCalls()).toBe(1);
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
      expect(
        yield* host
          .launch("pi", launch("agent-after-quarantined-anchor"), {
            ...supervisor,
            runId: "agent-after-quarantined-anchor",
          })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "herdr_ownership_mismatch" });
      expect(fake.splitCalls()).toBe(1);
      expect(yield* first.inspect.pipe(Effect.flip)).toMatchObject({
        code: "herdr_ownership_mismatch",
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
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
    }).pipe(Effect.scoped, Effect.provide(layer));
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
      expect(fake.closedWorkspaces()).toBe(1);
      expect(fake.cleanupAuthorizations()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(layer));
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
      expect(fake.closedWorkspaces()).toBe(1);
      expect(fake.cleanupAuthorizations()).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer));
    return Effect.gen(function* () {
      expect(Exit.isFailure(yield* scenario.pipe(Effect.exit))).toBe(true);
    });
  });

  it.live("refuses first activation after the original focus identity changes", () => {
    const fake = fakeTopology();
    fake.replaceOriginalTabBeforeFirstActivation();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const result = yield* Effect.result(
        host.launch("pi", launch("agent-replaced-initial-focus"), {
          ...supervisor,
          runId: "agent-replaced-initial-focus",
        }),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "herdr_focus_changed" },
      });
      expect(
        fake.focusOperations.filter((operation) => operation === "activate herdr tab"),
      ).toEqual([]);
      expect(fake.closedWorkspaces()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("does not restore focus to a reparented original tab id", () => {
    const fake = fakeTopology();
    fake.replaceOriginalTabDuringStart();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const hosted = yield* host.launch("pi", launch("agent-reparented-focus"), {
        ...supervisor,
        runId: "agent-reparented-focus",
      });
      expect(fake.focusedTab()).toBe("w:t");
      expect(fake.focusOperations.filter((operation) => operation === "restore focus")).toEqual([]);
      yield* hosted.close;
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("refuses a second activation probe after newer user focus", () => {
    const fake = fakeTopology();
    fake.moveFocusToOriginalAfterFirstProbe();
    const layer = HerdrHost.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
      ),
    );
    return Effect.gen(function* () {
      const host = yield* HerdrHost;
      const result = yield* Effect.result(
        host.launch("pi", launch("agent-focus-between-probes"), {
          ...supervisor,
          runId: "agent-focus-between-probes",
        }),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "herdr_focus_changed" },
      });
      expect(fake.paneCommands.map(({ operation }) => operation)).toEqual(["activate pane input"]);
      expect(
        fake.focusOperations.filter((operation) => operation === "activate herdr tab"),
      ).toEqual(["activate herdr tab"]);
      expect(fake.closedWorkspaces()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});
