// Test entry point composes the subject Layer once.
// @effect-diagnostics effect/strictEffectProvide:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import {
  HerdrCli,
  type HerdrAgent,
  type HerdrCliShape,
  type HerdrSnapshot,
} from "../src/boundary/herdr-cli.ts";
import { HerdrHarness, type HerdrHarnessShape } from "../src/boundary/herdr-harness.ts";
import { HerdrHost } from "../src/boundary/herdr-host.ts";
import type { SupervisorConnectionMetadata } from "../src/boundary/supervisor-channel.ts";
import type { BackendLaunchRequest } from "../src/backend/model.ts";
import { SubagentProcessError } from "../src/run/errors.ts";

const supervisor: SupervisorConnectionMetadata = {
  runId: "agent-1",
  host: "127.0.0.1",
  port: 1,
  stateDirectory: "/private",
  connectionConfigPath: "/private/connection.json",
  helperPath: "/private/helper.mjs",
  claudeMcp: {
    mcpServers: {
      pi_subagents_supervisor: {
        type: "stdio",
        command: process.execPath,
        args: ["/private/helper.mjs"],
        env: {},
      },
    },
  },
  codexMcp: {
    serverName: "pi_subagents_supervisor",
    command: process.execPath,
    args: ["/private/helper.mjs"],
    enabledTools: [
      "supervisor_progress",
      "supervisor_warning",
      "supervisor_question",
      "supervisor_submit_report",
    ],
    tomlFragment: "[mcp_servers.pi_subagents_supervisor]",
  },
};

const launch = (id: string): BackendLaunchRequest => ({
  runId: id,
  name: id,
  closeOnReport: false,
  cwd: "/project",
  context: "fresh",
  writeIntent: "read-only",
  model: "openai-codex/gpt-5.6-sol",
  effort: "xhigh",
  activeTools: [],
  projectTrusted: false,
  parentSessionId: "parent-session",
  systemPrompt: "fixed",
});

const fakeTopology = () => {
  let nextPane = 1;
  let workspaceLabel = "";
  let tabLive = false;
  let workLive = false;
  const panes = new Map<string, { terminalId: string; label?: string }>();
  const agents = new Map<string, HerdrAgent>();
  const closedPanes: string[] = [];
  let closedWorkspaces = 0;
  let failStartAfterApply = false;
  let failRollbackSnapshot = false;
  let startApplied = false;
  const snapshot = (): HerdrSnapshot => ({
    version: "0.7.5",
    protocol: 17,
    workspaces: workLive
      ? [{ workspaceId: "w", label: workspaceLabel, focused: false, activeTabId: "w:t" }]
      : [],
    tabs: tabLive
      ? [{ tabId: "w:t", workspaceId: "w", label: "1", paneCount: panes.size, focused: false }]
      : [],
    panes: [...panes].map(([paneId, pane]) => ({
      paneId,
      terminalId: pane.terminalId,
      workspaceId: "w",
      tabId: "w:t",
      cwd: "/project",
      foregroundCwd: "/project",
      ...(pane.label ? { label: pane.label } : {}),
      focused: false,
      agentStatus: agents.get(paneId)?.agentStatus ?? "unknown",
    })),
    agents: [...agents.values()].map((agent) => ({ ...agent })),
  });
  const cli: HerdrCliShape = {
    sessionIdentity: "inherited",
    preflight: () => Effect.void,
    snapshot: Effect.suspend(() =>
      startApplied && failRollbackSnapshot
        ? Effect.fail(
            new SubagentProcessError({
              operation: "session snapshot",
              code: "herdr_cli_failed",
              message: "Fixture rollback snapshot failed.",
            }),
          )
        : Effect.succeed(snapshot()),
    ),
    createWorkspace: (_cwd, label) =>
      Effect.sync(() => {
        workspaceLabel = label;
        workLive = true;
        tabLive = true;
        panes.set("w:p1", { terminalId: "term-1" });
        nextPane = 2;
        return {
          workspaceId: "w",
          workspaceLabel: label,
          tabId: "w:t",
          tabLabel: "1",
          rootPane: snapshot().panes[0]!,
        };
      }),
    splitPane: () =>
      Effect.sync(() => {
        const paneId = `w:p${nextPane}`;
        panes.set(paneId, { terminalId: `term-${nextPane}` });
        nextPane += 1;
        return snapshot().panes.find((pane) => pane.paneId === paneId)!;
      }),
    renamePane: (paneId, label) =>
      Effect.sync(() => {
        const pane = panes.get(paneId)!;
        panes.set(paneId, { ...pane, label });
      }),
    runPaneCommand: () => Effect.void,
    startAgent: ({ runtime, paneId, agentName }) =>
      Effect.suspend(() => {
        const pane = snapshot().panes.find((candidate) => candidate.paneId === paneId)!;
        const agent: HerdrAgent = {
          ...pane,
          agentStatus: "working",
          name: agentName,
          runtime,
          stateChangeSequence: 1,
          interactiveReady: true,
          agentSession: {
            source: "fixture",
            agent: runtime,
            kind: "id",
            value: `native-${paneId}`,
          },
          nativeSession: `native-${paneId}`,
        };
        agents.set(paneId, agent);
        startApplied = true;
        return failStartAfterApply
          ? Effect.fail(
              new SubagentProcessError({
                operation: "start agent",
                code: "herdr_start_agent_outcome_uncertain",
                message: "Fixture start applied before response failure.",
              }),
            )
          : Effect.succeed(agent);
      }),
    prompt: (name) => Effect.sync(() => [...agents.values()].find((agent) => agent.name === name)!),
    closePane: (paneId) =>
      Effect.sync(() => {
        closedPanes.push(paneId);
        agents.delete(paneId);
        panes.delete(paneId);
      }),
    closeWorkspace: () =>
      Effect.sync(() => {
        closedWorkspaces += 1;
        agents.clear();
        panes.clear();
        tabLive = false;
        workLive = false;
      }),
    focusTab: () => Effect.void,
  };
  let cleanupAuthorizations = 0;
  const harness: HerdrHarnessShape = {
    preflight: () => Effect.void,
    prepare: (runtime) =>
      Effect.succeed({
        directory: `/private/${runtime}`,
        runtime,
        argv: [],
        environmentCommand: () => "fixed-env",
        authorizeCleanup: () => {
          cleanupAuthorizations += 1;
        },
      }),
  };
  return {
    cli,
    harness,
    agents,
    closedPanes,
    closedWorkspaces: () => closedWorkspaces,
    cleanupAuthorizations: () => cleanupAuthorizations,
    failAppliedStartAndRollbackSnapshot: () => {
      failStartAfterApply = true;
      failRollbackSnapshot = true;
    },
  };
};

describe("session-owned Herdr topology", () => {
  it.live(
    "shares one workspace, closes only exact owned panes, and refuses mismatched identity",
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
        expect(first.paneId).not.toBe(second.paneId);

        const exact = fake.agents.get(first.paneId)!;
        fake.agents.set(first.paneId, {
          ...exact,
          agentSession: {
            ...exact.agentSession!,
            value: "native-restored-unowned",
          },
          nativeSession: "native-restored-unowned",
        });
        const mismatch = yield* first.close.pipe(Effect.flip);
        expect(mismatch).toMatchObject({
          _tag: "SubagentProcessError",
          code: "herdr_ownership_mismatch",
        });
        expect(fake.closedPanes).toEqual([]);
        fake.agents.set(first.paneId, exact);

        yield* first.close;
        expect(fake.closedPanes).toEqual([first.paneId]);
        expect(fake.cleanupAuthorizations()).toBe(1);
        yield* second.close;
        expect(fake.closedWorkspaces()).toBe(1);
        expect(fake.cleanupAuthorizations()).toBe(2);
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
        expect(fake.closedWorkspaces()).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );
});
