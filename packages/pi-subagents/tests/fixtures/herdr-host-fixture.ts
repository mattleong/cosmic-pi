// Stateful Herdr topology fixture shared by host integration suites.
import * as Effect from "effect/Effect";
import type { HerdrAgent, HerdrCliContract, HerdrSnapshot } from "../../src/boundary/herdr-cli.ts";
import type { HerdrHarnessContract } from "../../src/boundary/herdr-harness.ts";
import type { SupervisorConnectionMetadata } from "../../src/boundary/supervisor-channel.ts";
import type { BackendLaunchRequest } from "../../src/backend/model.ts";
import { SubagentProcessError } from "../../src/run/errors.ts";

export const supervisor: SupervisorConnectionMetadata = {
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

export const launch = (id: string): BackendLaunchRequest => ({
  runId: id,
  name: id,
  closeOnReport: false,
  cwd: "/project",
  context: "fresh",
  writeIntent: "read-only",
  fastMode: false,
  model: "openai-codex/gpt-5.6-sol",
  effort: "xhigh",
  activeTools: [],
  projectTrusted: false,
  parentSessionId: "019fd858-60cc-7d70-87fb-a88d44bbf8e6",
  systemPrompt: "fixed",
});

export const fakeTopology = () => {
  let nextPane = 1;
  let splitCalls = 0;
  const splitTargets: string[] = [];
  const panes = new Map<string, { terminalId: string; label?: string }>([
    ["user:p0", { terminalId: "user:term0", label: "Parent Pi" }],
  ]);
  const agents = new Map<string, HerdrAgent>();
  const activationConfirmations = new Map<string, number>();
  const shellProcessInspections = new Map<string, number>();
  const environmentMarkerInspections = new Map<string, number>();
  const shellInspectedPanes = new Set<string>();
  const closedPanes: string[] = [];
  const paneCommands: Array<{ readonly paneId: string; readonly operation: string }> = [];
  const focusOperations: string[] = [];
  let failStartAfterApply = false;
  let failRollbackSnapshot = false;
  let startApplied = false;
  let omitAgentSession = false;
  let focusedTabId = "user:t";
  let failFocusRestoration = false;
  let invalidSecretAttestation = false;
  let dropAllActivationProbes = false;
  let rejectStartAsBusy = false;
  let initialBusyShellInspections = 0;
  let transientPostActivationOccupancySnapshots = 0;
  let configuredPostActivationOccupancySnapshots = 0;
  let postActivationOccupancyPaneId: string | undefined;
  let replaceTerminalDuringShellInspection = false;
  let transientTerminalMismatchSnapshots = 0;
  let terminalMismatchSnapshotCountdown = 0;
  let driftAfterActivationFocus = false;
  let driftAfterOutput: "confirm pane input" | "confirm pane environment" | undefined;
  let validSecretBootstrap = false;
  let moveFocusOnPaneClose = false;
  let moveFocusAfterFirstProbe = false;
  let duplicateSelector: "workspace" | "tab" | "terminal" | undefined;
  let splitReturnsForeignPane = false;
  let processInfoReturnsWrongPane = false;
  let startReturnsMismatchedAgent = false;
  let agentNameCollision = false;
  let duplicateNameAfterStart = false;
  let driftOnFocusRestorationSnapshot = false;
  let replaceOriginalTabBeforeActivation = false;
  let plannedAgentName: string | undefined;
  let escapeAgentSelectorAfterClose = false;
  let escapedAgentName: string | undefined;
  let failPaneCloseAfterApply = false;
  let replaceOriginalTabIdentity = false;
  let blockPostCloseSnapshot = false;
  let currentPaneMismatch = false;
  let postCloseSnapshotReached = false;
  let notifyPostCloseSnapshotReached: (() => void) | undefined;
  let releasePostCloseSnapshot: (() => void) | undefined;
  const snapshot = (): HerdrSnapshot => {
    const showTerminalMismatch =
      transientTerminalMismatchSnapshots > 0 || terminalMismatchSnapshotCountdown === 1;
    transientTerminalMismatchSnapshots = Math.max(0, transientTerminalMismatchSnapshots - 1);
    terminalMismatchSnapshotCountdown = Math.max(0, terminalMismatchSnapshotCountdown - 1);
    const showPostActivationOccupancy = transientPostActivationOccupancySnapshots > 0;
    transientPostActivationOccupancySnapshots = Math.max(
      0,
      transientPostActivationOccupancySnapshots - 1,
    );
    return {
      version: "0.8.0",
      protocol: 19,
      focusedWorkspaceId: "user",
      focusedTabId,
      focusedPaneId: focusedTabId === "user:t" ? "user:p0" : undefined,
      workspaces: [
        {
          workspaceId: "user",
          label: "user",
          focused: true,
          activeTabId: focusedTabId,
        },
        ...(duplicateSelector === "workspace"
          ? [
              {
                workspaceId: "user",
                label: "replacement-workspace",
                focused: false,
                activeTabId: "user:t",
              },
            ]
          : []),
      ],
      tabs: [
        {
          tabId: "user:t",
          workspaceId: replaceOriginalTabIdentity ? "replacement-user" : "user",
          label: replaceOriginalTabIdentity ? "replacement-user" : "user",
          paneCount: panes.size,
          focused: focusedTabId === "user:t",
        },
        ...(duplicateSelector === "tab"
          ? [
              {
                tabId: "user:t",
                workspaceId: "replacement-workspace",
                label: "replacement-tab",
                paneCount: 0,
                focused: false,
              },
            ]
          : []),
        {
          tabId: "user:other",
          workspaceId: "user",
          label: "other",
          paneCount: 0,
          focused: focusedTabId === "user:other",
        },
      ],
      panes: [
        ...[...panes].map(([paneId, pane]) =>
          (() => {
            const paneView = {
              paneId,
              terminalId: showTerminalMismatch ? `${pane.terminalId}-replacement` : pane.terminalId,
              workspaceId: "user",
              tabId: "user:t",
              cwd: "/project",
              foregroundCwd: "/project",
              focused: paneId === "user:p0" && focusedTabId === "user:t",
              agentStatus: agents.get(paneId)?.agentStatus ?? "unknown",
            };
            return pane.label ? { ...paneView, label: pane.label } : paneView;
          })(),
        ),
        ...(duplicateSelector === "terminal" && panes.size > 0
          ? [
              {
                paneId: "replacement:p",
                terminalId: [...panes.values()][0]!.terminalId,
                workspaceId: "replacement-workspace",
                tabId: "replacement-tab",
                cwd: "/replacement",
                foregroundCwd: "/replacement",
                focused: false,
                agentStatus: "unknown" as const,
              },
            ]
          : []),
      ],
      agents: [
        ...[...agents.values()].map((agent) => ({ ...agent })),
        ...(showPostActivationOccupancy && postActivationOccupancyPaneId
          ? (() => {
              const pane = panes.get(postActivationOccupancyPaneId);
              return pane
                ? [
                    {
                      paneId: postActivationOccupancyPaneId,
                      terminalId: pane.terminalId,
                      workspaceId: "user",
                      tabId: "user:t",
                      cwd: "/project",
                      foregroundCwd: "/project",
                      focused: true,
                      agentStatus: "unknown" as const,
                      name: "transient-codex-detection",
                      runtime: "codex" as const,
                      stateChangeSequence: 1,
                    },
                  ]
                : [];
            })()
          : []),
        ...(agentNameCollision && plannedAgentName
          ? [
              {
                paneId: "foreign:p",
                terminalId: "foreign:t",
                workspaceId: "foreign:w",
                tabId: "foreign:t",
                cwd: "/foreign",
                foregroundCwd: "/foreign",
                focused: false,
                agentStatus: "working" as const,
                name: plannedAgentName,
                runtime: "pi",
                stateChangeSequence: 1,
              },
            ]
          : []),
        ...(escapedAgentName
          ? [
              {
                paneId: "escaped:p",
                terminalId: "escaped:t",
                workspaceId: "escaped:w",
                tabId: "escaped:t",
                cwd: "/escaped",
                foregroundCwd: "/escaped",
                focused: false,
                agentStatus: "working" as const,
                name: escapedAgentName,
                runtime: "pi",
                stateChangeSequence: 1,
              },
            ]
          : []),
      ],
    };
  };
  const cli: HerdrCliContract = {
    sessionIdentity: "inherited",
    callingPaneId: "user:p0",
    preflight: () => Effect.void,
    snapshot: Effect.suspend(() => {
      if (blockPostCloseSnapshot && closedPanes.length > 0) {
        blockPostCloseSnapshot = false;
        return Effect.callback<HerdrSnapshot>((resume) => {
          postCloseSnapshotReached = true;
          notifyPostCloseSnapshotReached?.();
          releasePostCloseSnapshot = () => resume(Effect.succeed(snapshot()));
        });
      }
      return startApplied && failRollbackSnapshot
        ? Effect.fail(
            new SubagentProcessError({
              operation: "session snapshot",
              code: "herdr_cli_failed",
              message: "Fixture rollback snapshot failed.",
            }),
          )
        : Effect.succeed(snapshot());
    }),
    currentPane: Effect.sync(() => {
      const pane = snapshot().panes.find((candidate) => candidate.paneId === "user:p0")!;
      return currentPaneMismatch ? { ...pane, paneId: "foreign:p" } : pane;
    }),
    splitPane: (anchorPaneId) =>
      Effect.sync(() => {
        splitCalls += 1;
        splitTargets.push(anchorPaneId);
        if (splitReturnsForeignPane)
          return {
            paneId: "foreign:p",
            terminalId: "foreign:t",
            workspaceId: "foreign:w",
            tabId: "foreign:t",
            cwd: "/foreign",
            foregroundCwd: "/foreign",
            focused: false,
            agentStatus: "unknown" as const,
          };
        if (!panes.has(anchorPaneId))
          throw new Error(`Fixture split anchor ${anchorPaneId} does not exist.`);
        const paneId = `user:p${nextPane}`;
        panes.set(paneId, { terminalId: `user:term${nextPane}` });
        nextPane += 1;
        const pane = snapshot().panes.find((candidate) => candidate.paneId === paneId)!;
        if (replaceOriginalTabBeforeActivation) replaceOriginalTabIdentity = true;
        return pane;
      }),
    renamePane: (paneId, label) =>
      Effect.sync(() => {
        const pane = panes.get(paneId)!;
        panes.set(paneId, { ...pane, label });
      }),
    runPaneCommand: (paneId, _command, operation) =>
      Effect.suspend(() => {
        if (
          operation === "load pane secrets" &&
          (shellProcessInspections.get(paneId) ?? 0) <=
            (environmentMarkerInspections.get(paneId) ?? 0)
        )
          return Effect.fail(
            new SubagentProcessError({
              operation,
              code: "fixture_secret_before_replacement_shell",
              message: "Fixture requires fresh shell inspection after the environment marker.",
            }),
          );
        paneCommands.push({ paneId, operation });
        return focusedTabId !== "user:t"
          ? Effect.fail(
              new SubagentProcessError({
                operation: "prepare pane environment",
                code: "fixture_unfocused_input_stalled",
                message: "Fixture models Herdr input stalling in a never-focused workspace.",
              }),
            )
          : !shellInspectedPanes.has(paneId)
            ? Effect.fail(
                new SubagentProcessError({
                  operation: "activate pane input",
                  code: "fixture_input_before_shell_ready",
                  message:
                    "Fixture rejects input while a transient native TUI still owns the pane.",
                }),
              )
            : Effect.void;
      }),
    waitPaneOutput: (paneId, _marker, operation) =>
      Effect.suspend(() => {
        if (operation === "confirm pane input") {
          const attempts = (activationConfirmations.get(paneId) ?? 0) + 1;
          activationConfirmations.set(paneId, attempts);
          if (attempts === 1 || dropAllActivationProbes) {
            if (attempts === 1 && moveFocusAfterFirstProbe) focusedTabId = "user:other";
            return Effect.fail(
              new SubagentProcessError({
                operation,
                code: "timeout",
                message: "Fixture drops the first harmless input in a restored workspace.",
              }),
            );
          }
        }
        if (
          operation === "confirm pane input" &&
          (activationConfirmations.get(paneId) ?? 0) > 1 &&
          configuredPostActivationOccupancySnapshots > 0
        ) {
          postActivationOccupancyPaneId = paneId;
          transientPostActivationOccupancySnapshots = configuredPostActivationOccupancySnapshots;
        }
        if (operation === "confirm pane environment")
          environmentMarkerInspections.set(paneId, shellProcessInspections.get(paneId) ?? 0);
        if (driftAfterOutput === operation) transientTerminalMismatchSnapshots = 1;
        return Effect.void;
      }),
    paneProcessInfo: (paneId) =>
      Effect.sync(() => {
        const inspections = (shellProcessInspections.get(paneId) ?? 0) + 1;
        shellProcessInspections.set(paneId, inspections);
        if (replaceTerminalDuringShellInspection && inspections === 1) {
          const pane = panes.get(paneId)!;
          panes.set(paneId, { ...pane, terminalId: `${pane.terminalId}-replacement` });
        }
        if (inspections <= initialBusyShellInspections)
          return {
            paneId: processInfoReturnsWrongPane ? "foreign:p" : paneId,
            shellPid: 4242,
            foregroundProcessGroupId: 4343,
            foregroundProcesses: [{ pid: 4343, name: "codex" }],
          };
        shellInspectedPanes.add(paneId);
        return {
          paneId: processInfoReturnsWrongPane ? "foreign:p" : paneId,
          shellPid: 4242,
          foregroundProcessGroupId: 4242,
          foregroundProcesses: [{ pid: 4242, name: "zsh" }],
        };
      }),
    startAgent: ({ runtime, paneId, agentName }) =>
      Effect.suspend(() => {
        if (!shellInspectedPanes.has(paneId))
          return Effect.fail(
            new SubagentProcessError({
              operation: "start agent",
              code: "fixture_shell_not_inspected",
              message: "Fixture requires shell readiness inspection before start.",
            }),
          );
        if (rejectStartAsBusy)
          return Effect.fail(
            new SubagentProcessError({
              operation: "start agent",
              code: "agent_pane_busy",
              message: "Fixture rejects start before application because the pane is busy.",
            }),
          );
        const pane = snapshot().panes.find((candidate) => candidate.paneId === paneId)!;
        const agent: HerdrAgent = (() => {
          const baseResult = {
            ...pane,
            agentStatus: "working" as const,
            name: agentName,
            runtime,
            stateChangeSequence: 1,
            interactiveReady: true,
          };
          const withAgentSessionAndNativeSession = omitAgentSession
            ? baseResult
            : {
                ...baseResult,
                agentSession: {
                  source: "fixture",
                  agent: runtime,
                  kind: "id" as const,
                  value: `native-${paneId}`,
                },
                nativeSession: `native-${paneId}`,
              };
          return withAgentSessionAndNativeSession;
        })();
        agents.set(paneId, agent);
        if (duplicateNameAfterStart) agentNameCollision = true;
        if (driftOnFocusRestorationSnapshot) terminalMismatchSnapshotCountdown = 2;
        startApplied = true;
        if (failFocusRestoration) focusedTabId = "user:t";
        return failStartAfterApply
          ? Effect.fail(
              new SubagentProcessError({
                operation: "start agent",
                code: "herdr_start_agent_outcome_uncertain",
                message: "Fixture start applied before response failure.",
              }),
            )
          : Effect.succeed(
              startReturnsMismatchedAgent
                ? { ...agent, terminalId: `${agent.terminalId}-replacement` }
                : agent,
            );
      }),
    prompt: (name) => Effect.sync(() => [...agents.values()].find((agent) => agent.name === name)!),
    closePane: (paneId) =>
      Effect.suspend(() => {
        const closedAgentName = agents.get(paneId)?.name;
        closedPanes.push(paneId);
        agents.delete(paneId);
        panes.delete(paneId);
        if (escapeAgentSelectorAfterClose) escapedAgentName = closedAgentName;
        if (moveFocusOnPaneClose) focusedTabId = "user:other";
        return failPaneCloseAfterApply
          ? Effect.fail(
              new SubagentProcessError({
                operation: "close pane",
                code: "herdr_close_pane_outcome_uncertain",
                message: "Fixture applied pane close before losing its response.",
              }),
            )
          : Effect.void;
      }),
    focusTab: (tabId, operation) => {
      focusOperations.push(operation);
      return failFocusRestoration && operation === "restore focus"
        ? Effect.fail(
            new SubagentProcessError({
              operation: "restore focus",
              code: "herdr_restore_focus_outcome_uncertain",
              message: "Fixture focus restoration failed.",
            }),
          )
        : Effect.sync(() => {
            focusedTabId = tabId;
            if (driftAfterActivationFocus && operation === "activate herdr tab")
              transientTerminalMismatchSnapshots = 1;
          });
    },
  };
  let cleanupAuthorizations = 0;
  const harness: HerdrHarnessContract = {
    preflight: () => Effect.void,
    prepare: (runtime, request) =>
      Effect.sync(() => {
        plannedAgentName = request.name;
        return {
          directory: `/private/${runtime}`,
          runtime,
          argv: [],
          environmentCommand: () => "fixed-env",
          environmentReadyMarker: "fixture-env-ready",
          activationProbe: (attempt) => ({
            command: `activate-${attempt.toString()}`,
            marker: `fixture-activate-${attempt.toString()}`,
          }),
          shellReadinessProbe: (phase) => ({
            command: `confirm-shell-${phase}`,
            marker: `fixture-shell-${phase}`,
          }),
          ...(invalidSecretAttestation
            ? { secretCommand: "load-secret" }
            : validSecretBootstrap
              ? { secretCommand: "load-secret", secretReadyMarker: "fixture-secret-ready" }
              : {}),
          authorizeCleanup: () => {
            cleanupAuthorizations += 1;
          },
        };
      }),
  };
  return {
    cli,
    harness,
    agents,
    activationConfirmations,
    shellProcessInspections,
    shellInspectedPanes,
    closedPanes,
    paneCommands,
    focusOperations,
    splitCalls: () => splitCalls,
    splitTargets: () => [...splitTargets],
    cleanupAuthorizations: () => cleanupAuthorizations,
    focusedTab: () => focusedTabId,
    callerPaneId: "user:p0",
    callerPaneLive: () => panes.has("user:p0"),
    dropEveryActivationProbe: () => {
      dropAllActivationProbes = true;
    },
    delayInitialShellReadiness: (inspections: number) => {
      initialBusyShellInspections = inspections;
    },
    delayPostActivationAgentClearance: (snapshots: number) => {
      configuredPostActivationOccupancySnapshots = snapshots;
    },
    replaceTerminalOnFirstShellInspection: () => {
      replaceTerminalDuringShellInspection = true;
    },
    driftAfterFocus: () => {
      driftAfterActivationFocus = true;
    },
    driftAfterMarker: (operation: "confirm pane input" | "confirm pane environment") => {
      driftAfterOutput = operation;
    },
    enableSecretBootstrap: () => {
      validSecretBootstrap = true;
    },
    moveFocusToOtherOnPaneClose: () => {
      moveFocusOnPaneClose = true;
    },
    moveFocusToOriginalAfterFirstProbe: () => {
      moveFocusAfterFirstProbe = true;
    },
    injectDuplicateSelector: (selector: "workspace" | "tab" | "terminal") => {
      duplicateSelector = selector;
    },
    returnForeignSplitPane: () => {
      splitReturnsForeignPane = true;
    },
    returnWrongProcessInfoPane: () => {
      processInfoReturnsWrongPane = true;
    },
    returnMismatchedStartedAgent: () => {
      startReturnsMismatchedAgent = true;
    },
    injectAgentNameCollision: () => {
      agentNameCollision = true;
    },
    duplicateAgentNameAfterStart: () => {
      duplicateNameAfterStart = true;
    },
    driftDuringFocusRestoration: () => {
      driftOnFocusRestorationSnapshot = true;
    },
    replaceOriginalTabBeforeFirstActivation: () => {
      replaceOriginalTabBeforeActivation = true;
    },
    escapeAgentNameAfterClose: () => {
      escapeAgentSelectorAfterClose = true;
    },
    failPaneCloseAfterApplying: () => {
      failPaneCloseAfterApply = true;
    },
    blockSnapshotAfterPaneClose: () => {
      blockPostCloseSnapshot = true;
      postCloseSnapshotReached = false;
      notifyPostCloseSnapshotReached = undefined;
    },
    awaitBlockedPostCloseSnapshot: () =>
      Effect.callback<void>((resume) => {
        if (postCloseSnapshotReached) resume(Effect.void);
        else notifyPostCloseSnapshotReached = () => resume(Effect.void);
      }),
    releaseBlockedPostCloseSnapshot: () => {
      releasePostCloseSnapshot?.();
    },
    rejectStartWithPaneBusy: () => {
      rejectStartAsBusy = true;
    },
    failAppliedStartAndRollbackSnapshot: () => {
      failStartAfterApply = true;
      failRollbackSnapshot = true;
    },
    omitNativeSession: () => {
      omitAgentSession = true;
    },
    invalidateSecretAttestation: () => {
      invalidSecretAttestation = true;
    },
    failRestoreFocus: () => {
      failFocusRestoration = true;
    },
    switchToOtherTab: () => {
      focusedTabId = "user:other";
    },
    mismatchCurrentPane: () => {
      currentPaneMismatch = true;
    },
    removeCallerPane: () => {
      panes.delete("user:p0");
    },
  };
};
