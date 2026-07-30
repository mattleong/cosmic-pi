// Test Layers intentionally provide the complete service graph at one entry point.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/strictEffectProvide:off
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { afterEach, describe, expect } from "vitest";
import { HerdrClient, type HerdrClientShape } from "../src/boundary/herdr-client.ts";
import { ReportChannel, type ReportChannelShape } from "../src/boundary/report-channel.ts";
import { DEFAULT_HERDR_CONFIG, type PersistedHerdrProject } from "../src/config/schema.ts";
import { HerdrConfigStore, type HerdrConfigStoreShape } from "../src/config/store.ts";
import { HerdrCommandError } from "../src/herd/errors.ts";
import type { HerdrReport, HerdrSnapshot } from "../src/herd/model.ts";
import { HerdrService } from "../src/herd/service.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const baseSnapshot = (): HerdrSnapshot => ({
  version: "0.7.5",
  protocol: 17,
  focusedWorkspaceId: "w1",
  focusedTabId: "w1:t1",
  focusedPaneId: "w1:p1",
  workspaces: [{ workspaceId: "w1", label: "repo", focused: true, activeTabId: "w1:t1" }],
  tabs: [
    {
      tabId: "w1:t1",
      workspaceId: "w1",
      label: "main",
      paneCount: 1,
      focused: true,
    },
  ],
  panes: [
    {
      paneId: "w1:p1",
      terminalId: "term-main",
      workspaceId: "w1",
      tabId: "w1:t1",
      cwd: "/repo",
      foregroundCwd: "/repo",
      focused: true,
      agentStatus: "idle",
    },
  ],
  agents: [],
  layouts: [],
});

const fixture = (
  options: {
    readonly busyStarts?: number;
    readonly focusOnStart?: boolean;
    readonly kindMismatchStarts?: number;
  } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdr-service-"));
  roots.push(root);
  let snapshot = baseSnapshot();
  let closeCalls = 0;
  let splitCalls = 0;
  let startAttempts = 0;
  let prepareCount = 0;
  let nextPaneOrdinal = 3;
  let lastStartedPaneId: string | undefined;
  let report: HerdrReport | undefined;
  const focusCalls: string[] = [];
  const saved: PersistedHerdrProject[] = [];
  const client: HerdrClientShape = {
    sessionIdentity: "default",
    preflight: Effect.void,
    snapshot: Effect.sync(() => snapshot),
    createWorkspace: () => Effect.die("unexpected workspace creation"),
    renameTab: () => Effect.void,
    createTab: (workspaceId, cwd, label) =>
      Effect.sync(() => {
        const tab = {
          tabId: "w1:t2",
          workspaceId,
          label,
          paneCount: 1,
          focused: false,
        };
        const rootPane = {
          paneId: "w1:p2",
          terminalId: "term-anchor",
          workspaceId,
          tabId: tab.tabId,
          cwd,
          focused: false,
          agentStatus: "idle" as const,
        };
        snapshot = {
          ...snapshot,
          tabs: [...snapshot.tabs, tab],
          panes: [...snapshot.panes, rootPane],
          layouts: [
            {
              workspaceId,
              tabId: tab.tabId,
              panes: [{ paneId: rootPane.paneId, width: 120, height: 40 }],
            },
          ],
        };
        return { tab, rootPane };
      }),
    splitPane: (sourcePaneId, cwd) =>
      Effect.sync(() => {
        splitCalls += 1;
        const source = snapshot.panes.find((pane) => pane.paneId === sourcePaneId);
        if (!source) throw new Error("missing split source");
        const paneId = `w1:p${nextPaneOrdinal++}`;
        const pane = {
          paneId,
          terminalId: `term-${paneId}`,
          workspaceId: source.workspaceId,
          tabId: source.tabId,
          cwd,
          focused: false,
          agentStatus: "idle" as const,
        };
        const tabPanes = [
          ...snapshot.panes.filter((candidate) => candidate.tabId === source.tabId),
          pane,
        ];
        snapshot = {
          ...snapshot,
          panes: [...snapshot.panes, pane],
          layouts: [
            {
              workspaceId: source.workspaceId,
              tabId: source.tabId,
              panes: tabPanes.map((candidate) => ({
                paneId: candidate.paneId,
                width: 60,
                height: 40,
              })),
            },
          ],
        };
        return pane;
      }),
    renamePane: () => Effect.void,
    startClaude: ({ paneId, name }) => {
      startAttempts += 1;
      if (startAttempts <= (options.busyStarts ?? 0))
        return Effect.fail(
          new HerdrCommandError({
            operation: "start Claude Code",
            code: "agent_pane_busy",
            message: "agent target pane is not an available shell",
          }),
        );
      if (startAttempts <= (options.kindMismatchStarts ?? 0))
        return Effect.fail(
          new HerdrCommandError({
            operation: "start Claude Code",
            code: "agent_kind_mismatch",
            message: "expected Claude, detected Codex",
          }),
        );
      return Effect.sync(() => {
        const ownedPane = snapshot.panes.find((pane) => pane.paneId === paneId);
        if (!ownedPane) throw new Error("missing fake agent pane");
        lastStartedPaneId = paneId;
        const agent = {
          paneId,
          terminalId: ownedPane.terminalId,
          workspaceId: ownedPane.workspaceId,
          tabId: ownedPane.tabId,
          cwd: ownedPane.cwd ?? "/repo",
          focused: false,
          agentStatus: "idle" as const,
          name,
          agent: "claude",
          stateChangeSeq: 1,
          interactiveReady: true,
        };
        snapshot = {
          ...snapshot,
          ...(options.focusOnStart
            ? { focusedTabId: agent.tabId, focusedPaneId: agent.paneId }
            : {}),
          tabs: snapshot.tabs.map((tab) => ({
            ...tab,
            focused: options.focusOnStart ? tab.tabId === agent.tabId : tab.focused,
          })),
          panes: snapshot.panes.map((candidate) => ({
            ...candidate,
            focused: options.focusOnStart ? candidate.paneId === agent.paneId : candidate.focused,
          })),
          agents: [...snapshot.agents.filter((candidate) => candidate.name !== name), agent],
        };
        return agent;
      });
    },
    prompt: (target) =>
      Effect.sync(() => {
        const current = snapshot.agents.find((agent) => agent.name === target);
        if (!current) throw new Error("missing fake agent");
        const agent = { ...current, agentStatus: "working" as const, stateChangeSeq: 2 };
        snapshot = {
          ...snapshot,
          agents: snapshot.agents.map((candidate) =>
            candidate.name === target ? agent : candidate,
          ),
        };
        return agent;
      }),
    listAgents: Effect.sync(() => snapshot.agents),
    readAgent: () => Effect.succeed("terminal"),
    closePane: (paneId) =>
      Effect.sync(() => {
        closeCalls += 1;
        const closing = snapshot.panes.find((pane) => pane.paneId === paneId);
        if (!closing) return;
        const remaining = snapshot.panes.filter((pane) => pane.paneId !== paneId);
        const focusedPane = remaining.find((pane) => pane.tabId === closing.tabId);
        snapshot = {
          ...snapshot,
          focusedTabId: closing.tabId,
          ...(focusedPane ? { focusedPaneId: focusedPane.paneId } : {}),
          tabs: snapshot.tabs.map((tab) => ({ ...tab, focused: tab.tabId === closing.tabId })),
          panes: remaining.map((pane) => ({
            ...pane,
            focused: pane.paneId === focusedPane?.paneId,
          })),
          agents: snapshot.agents.filter((agent) => agent.paneId !== paneId),
        };
      }),
    focusTab: (tabId) =>
      Effect.sync(() => {
        focusCalls.push(tabId);
        const focusedPane = snapshot.panes.find((pane) => pane.tabId === tabId);
        snapshot = {
          ...snapshot,
          focusedTabId: tabId,
          ...(focusedPane ? { focusedPaneId: focusedPane.paneId } : {}),
          tabs: snapshot.tabs.map((tab) => ({ ...tab, focused: tab.tabId === tabId })),
          panes: snapshot.panes.map((pane) => ({
            ...pane,
            focused: pane.paneId === focusedPane?.paneId,
          })),
        };
      }),
    focusAgent: () => Effect.void,
  };
  const reports: ReportChannelShape = {
    prepare: Effect.sync(() => {
      prepareCount += 1;
      const suffix = prepareCount === 1 ? "" : `-${prepareCount}`;
      return {
        runId: `herdr-test-run${suffix}`,
        agentName: `pih-test-run${suffix}`,
        generation: `herdr-test-run${suffix}`,
        directory: `/private/run${suffix}`,
        mcpConfigPath: `/private/run${suffix}/mcp.json`,
      };
    }),
    read: () => Effect.succeed(report),
    remove: () => Effect.void,
  };
  const store: HerdrConfigStoreShape = {
    config: DEFAULT_HERDR_CONFIG,
    statePath: join(root, "state.json"),
    loadProject: () => Effect.succeed(undefined),
    saveProject: (project) =>
      Effect.sync(() => {
        saved.push(project);
      }),
  };
  const dependencies = Layer.mergeAll(
    nodeFilePlatformLayer,
    Layer.succeed(HerdrClient, HerdrClient.of(client)),
    Layer.succeed(ReportChannel, ReportChannel.of(reports)),
    Layer.succeed(HerdrConfigStore, HerdrConfigStore.of(store)),
  );
  const layer = HerdrService.layer({ cwd: "/repo" }).pipe(Layer.provide(dependencies));
  return {
    layer,
    saved,
    closeCalls: () => closeCalls,
    splitCalls: () => splitCalls,
    managedTabExists: () => snapshot.tabs.some((tab) => tab.label === "pi-herdr · Claude"),
    managedPaneCount: () => snapshot.panes.filter((pane) => pane.tabId === "w1:t2").length,
    managedBlankPaneCount: () =>
      snapshot.panes.filter(
        (pane) =>
          pane.tabId === "w1:t2" && !snapshot.agents.some((agent) => agent.paneId === pane.paneId),
      ).length,
    focusCalls: () => [...focusCalls],
    startAttempts: () => startAttempts,
    completeReport: () => {
      report = {
        generation: "herdr-test-run",
        status: "completed",
        report: "done",
        submittedAt: 2_000,
      };
    },
    settleLastAgentWithoutReport: () => {
      snapshot = {
        ...snapshot,
        agents: snapshot.agents.map((agent) =>
          agent.paneId === lastStartedPaneId
            ? { ...agent, agentStatus: "done", stateChangeSeq: agent.stateChangeSeq + 1 }
            : agent,
        ),
      };
    },
    removeAgentPane: () => {
      snapshot = {
        ...snapshot,
        panes: snapshot.panes.filter((pane) => pane.paneId !== lastStartedPaneId),
      };
    },
    replaceAgentTerminal: () => {
      snapshot = {
        ...snapshot,
        panes: snapshot.panes.map((pane) =>
          pane.paneId === lastStartedPaneId ? { ...pane, terminalId: "foreign-terminal" } : pane,
        ),
      };
    },
  };
};

describe("HerdrService", () => {
  it.effect(
    "creates one managed tab, starts a read-only run, and leaves its pane on shutdown",
    () =>
      Effect.gen(function* () {
        const test = fixture();
        const run = yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* HerdrService;
            const started = yield* service.start({ task: "Review auth" });
            expect(started).toMatchObject({
              id: "herdr-test-run",
              agentName: "pih-test-run",
              workspaceId: "w1",
              tabId: "w1:t2",
              paneId: "w1:p2",
              state: "working",
            });
            return started;
          }).pipe(Effect.provide(test.layer)),
        );
        expect(run.state).toBe("working");
        expect(test.saved.at(-1)).toMatchObject({
          workspaceId: "w1",
          tabId: "w1:t2",
          anchorPaneId: "w1:p2",
        });
        expect(test.closeCalls()).toBe(0);
        expect(test.splitCalls()).toBe(0);
        expect(test.managedBlankPaneCount()).toBe(0);
      }),
  );

  it.effect("uses the root pane first and splits only for additional agents", () =>
    Effect.gen(function* () {
      const test = fixture();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* HerdrService;
          const first = yield* service.start({ task: "Review auth" });
          const second = yield* service.start({ task: "Review config" });
          expect(first.paneId).toBe("w1:p2");
          expect(second.paneId).toBe("w1:p3");
          expect(test.splitCalls()).toBe(1);
          expect(test.managedPaneCount()).toBe(2);
          expect(test.managedBlankPaneCount()).toBe(0);
        }).pipe(Effect.provide(test.layer)),
      );
    }),
  );

  it.effect("restores focus if starting in the root pane activates the managed tab", () =>
    Effect.gen(function* () {
      const test = fixture({ focusOnStart: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* HerdrService;
          yield* service.start({ task: "Review auth" });
          expect(test.focusCalls()).toEqual(["w1:t1"]);
        }).pipe(Effect.provide(test.layer)),
      );
    }),
  );

  it.effect("replaces and retries a pane after transient agent kind misdetection", () =>
    Effect.gen(function* () {
      const test = fixture({ kindMismatchStarts: 1 });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* HerdrService;
          const started = yield* service.start({ task: "Review auth" });
          expect(test.startAttempts()).toBe(2);
          expect(started.state).toBe("working");
          expect(test.startAttempts()).toBe(2);
          expect(test.closeCalls()).toBe(1);
          expect(test.splitCalls()).toBe(1);
          expect(test.managedBlankPaneCount()).toBe(0);
        }).pipe(Effect.provide(test.layer)),
      );
    }),
  );

  it.effect("retries a newly available pane until its shell becomes available", () =>
    Effect.gen(function* () {
      const test = fixture({ busyStarts: 2 });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* HerdrService;
          const starting = yield* service.start({ task: "Review auth" }).pipe(Effect.forkScoped);
          while (test.startAttempts() < 1) yield* Effect.yieldNow;
          yield* TestClock.adjust("1 second");
          const started = yield* Fiber.join(starting);
          expect(started.state).toBe("working");
          expect(test.startAttempts()).toBe(3);
        }).pipe(Effect.provide(test.layer)),
      );
    }),
  );

  it.effect("closes a reported agent and retains the required replacement shell", () =>
    Effect.gen(function* () {
      const test = fixture();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* HerdrService;
          const started = yield* service.start({ task: "Review auth" });
          test.completeReport();
          yield* TestClock.adjust("1 second");
          let completed = yield* service.status(started.id);
          while (completed.state !== "completed") {
            yield* Effect.yieldNow;
            completed = yield* service.status(started.id);
          }
          expect(completed.report).toBe("done");
          expect(test.managedTabExists()).toBe(true);
          expect(test.managedPaneCount()).toBe(1);
          expect(test.managedBlankPaneCount()).toBe(1);
          expect(test.closeCalls()).toBe(1);
        }).pipe(Effect.provide(test.layer)),
      );
    }),
  );

  it.effect("retains an agent pane when it fails without a durable report", () =>
    Effect.gen(function* () {
      const test = fixture();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* HerdrService;
          const started = yield* service.start({ task: "Review auth" });
          test.settleLastAgentWithoutReport();
          yield* Effect.yieldNow;
          yield* TestClock.adjust("1 second");
          for (let index = 0; index < 100; index++) yield* Effect.yieldNow;
          const observed = yield* service.status(started.id);
          expect(observed.state).toBe("awaiting_report");
          yield* Effect.yieldNow;
          yield* TestClock.adjust("16 seconds");
          for (let index = 0; index < 100; index++) yield* Effect.yieldNow;
          const failed = yield* service.status(started.id);
          expect(failed.state).toBe("failed");
          expect(failed.report).toBeUndefined();
          expect(test.managedBlankPaneCount()).toBe(0);
          expect(test.closeCalls()).toBe(0);
        }).pipe(Effect.provide(test.layer)),
      );
    }),
  );

  it.effect("restores the previously focused tab after stopping a background pane", () =>
    Effect.gen(function* () {
      const test = fixture();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* HerdrService;
          const started = yield* service.start({ task: "Review auth" });
          const stopped = yield* service.stop(started.id);
          expect(stopped.state).toBe("stopped");
          expect(test.closeCalls()).toBe(1);
          expect(test.managedTabExists()).toBe(true);
          expect(test.managedPaneCount()).toBe(1);
          expect(test.managedBlankPaneCount()).toBe(1);
          expect(test.focusCalls()).toEqual(["w1:t1"]);
          expect((yield* service.start({ task: "Review auth again" })).state).toBe("working");
          expect(test.managedBlankPaneCount()).toBe(0);
        }).pipe(Effect.provide(test.layer)),
      );
    }),
  );

  it.effect("refuses to close a pane whose ownership tuple changed", () =>
    Effect.gen(function* () {
      const test = fixture();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* HerdrService;
          const started = yield* service.start({ task: "Review auth" });
          test.replaceAgentTerminal();
          const failure = yield* Effect.flip(service.stop(started.id));
          expect(failure).toMatchObject({
            _tag: "HerdrOwnershipError",
            code: "owned_pane_mismatch",
          });
          expect(test.closeCalls()).toBe(0);
        }).pipe(Effect.provide(test.layer)),
      );
    }),
  );

  it.effect("marks an already-missing owned pane stopped without closing another resource", () =>
    Effect.gen(function* () {
      const test = fixture();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* HerdrService;
          const started = yield* service.start({ task: "Review auth" });
          test.removeAgentPane();
          const stopped = yield* service.stop(started.id);
          expect(stopped.state).toBe("stopped");
          expect(test.closeCalls()).toBe(0);
        }).pipe(Effect.provide(test.layer)),
      );
    }),
  );
});
