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
  let workspaceLabel = "";
  let tabLive = false;
  let workLive = false;
  const panes = new Map<string, { terminalId: string; label?: string }>();
  const agents = new Map<string, HerdrAgent>();
  const activationConfirmations = new Map<string, number>();
  const shellProcessInspections = new Map<string, number>();
  const environmentMarkerInspections = new Map<string, number>();
  const shellInspectedPanes = new Set<string>();
  const closedPanes: string[] = [];
  const paneCommands: Array<{ readonly paneId: string; readonly operation: string }> = [];
  const focusOperations: string[] = [];
  let closedWorkspaces = 0;
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
  let moveFocusOnWorkspaceClose = false;
  let moveFocusAfterFirstProbe = false;
  let duplicateSelector: "workspace" | "tab" | "terminal" | undefined;
  let splitReturnsForeignPane = false;
  let processInfoReturnsWrongPane = false;
  let startReturnsMismatchedAgent = false;
  let agentNameCollision = false;
  let duplicateNameAfterStart = false;
  let driftOnFocusRestorationSnapshot = false;
  let replaceOriginalTabOnStart = false;
  let replaceOriginalTabBeforeActivation = false;
  let plannedAgentName: string | undefined;
  let escapeAgentSelectorAfterClose = false;
  let escapedAgentName: string | undefined;
  let failWorkspaceCloseAfterApply = false;
  let replaceOriginalTabIdentity = false;
  let blockPostCloseSnapshot = false;
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
      focusedTabId,
      workspaces: workLive
        ? [
            { workspaceId: "w", label: workspaceLabel, focused: false, activeTabId: "w:t" },
            ...(duplicateSelector === "workspace"
              ? [
                  {
                    workspaceId: "w",
                    label: "replacement-workspace",
                    focused: false,
                    activeTabId: "w:t",
                  },
                ]
              : []),
          ]
        : [],
      tabs: [
        ...(tabLive
          ? [
              { tabId: "w:t", workspaceId: "w", label: "1", paneCount: panes.size, focused: false },
              ...(duplicateSelector === "tab"
                ? [
                    {
                      tabId: "w:t",
                      workspaceId: "replacement-workspace",
                      label: "replacement-tab",
                      paneCount: 0,
                      focused: false,
                    },
                  ]
                : []),
            ]
          : []),
        {
          tabId: "user:t",
          workspaceId: replaceOriginalTabIdentity ? "replacement-user" : "user",
          label: replaceOriginalTabIdentity ? "replacement-user" : "user",
          paneCount: 0,
          focused: focusedTabId === "user:t",
        },
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
            const objectPart5927_0 = {
              paneId,
              terminalId: showTerminalMismatch ? `${pane.terminalId}-replacement` : pane.terminalId,
              workspaceId: "w",
              tabId: "w:t",
              cwd: "/project",
              foregroundCwd: "/project",
            };
            const objectPart5927_1 = pane.label
              ? { ...objectPart5927_0, label: pane.label }
              : objectPart5927_0;
            const objectPart5927_2 = {
              ...objectPart5927_1,
              focused: false,
              agentStatus: agents.get(paneId)?.agentStatus ?? "unknown",
            };
            return objectPart5927_2;
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
                      workspaceId: "w",
                      tabId: "w:t",
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
    preflight: () => Effect.void,
    snapshot: Effect.suspend(() => {
      if (blockPostCloseSnapshot && closedWorkspaces > 0) {
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
    createWorkspace: (_cwd, label) =>
      Effect.sync(() => {
        workspaceLabel = label;
        workLive = true;
        tabLive = true;
        panes.set("w:p1", { terminalId: "term-1" });
        nextPane = 2;
        const rootPane = snapshot().panes[0]!;
        if (replaceOriginalTabBeforeActivation) replaceOriginalTabIdentity = true;
        return {
          workspaceId: "w",
          workspaceLabel: label,
          tabId: "w:t",
          tabLabel: "1",
          rootPane,
        };
      }),
    splitPane: () =>
      Effect.sync(() => {
        splitCalls += 1;
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
        return focusedTabId !== "w:t"
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
            if (attempts === 1 && moveFocusAfterFirstProbe) focusedTabId = "user:t";
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
          const objectPart14279_0 = {
            ...pane,
            agentStatus: "working" as const,
            name: agentName,
            runtime,
            stateChangeSequence: 1,
            interactiveReady: true,
          };
          const objectPart14279_1 = omitAgentSession
            ? objectPart14279_0
            : {
                ...objectPart14279_0,
                agentSession: {
                  source: "fixture",
                  agent: runtime,
                  kind: "id" as const,
                  value: `native-${paneId}`,
                },
                nativeSession: `native-${paneId}`,
              };
          return objectPart14279_1;
        })();
        agents.set(paneId, agent);
        if (duplicateNameAfterStart) agentNameCollision = true;
        if (driftOnFocusRestorationSnapshot) terminalMismatchSnapshotCountdown = 2;
        if (replaceOriginalTabOnStart) replaceOriginalTabIdentity = true;
        startApplied = true;
        if (failFocusRestoration) focusedTabId = "w:t";
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
      Effect.sync(() => {
        closedPanes.push(paneId);
        agents.delete(paneId);
        panes.delete(paneId);
      }),
    closeWorkspace: () =>
      Effect.suspend(() => {
        closedWorkspaces += 1;
        if (escapeAgentSelectorAfterClose) escapedAgentName = [...agents.values()][0]?.name;
        agents.clear();
        panes.clear();
        tabLive = false;
        workLive = false;
        if (focusedTabId === "w:t")
          focusedTabId = moveFocusOnWorkspaceClose ? "user:other" : "user:t";
        return failWorkspaceCloseAfterApply
          ? Effect.fail(
              new SubagentProcessError({
                operation: "close workspace",
                code: "herdr_close_workspace_outcome_uncertain",
                message: "Fixture applied workspace close before losing its response.",
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
    closedWorkspaces: () => closedWorkspaces,
    splitCalls: () => splitCalls,
    cleanupAuthorizations: () => cleanupAuthorizations,
    focusedTab: () => focusedTabId,
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
    moveFocusToOtherOnWorkspaceClose: () => {
      moveFocusOnWorkspaceClose = true;
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
    replaceOriginalTabDuringStart: () => {
      replaceOriginalTabOnStart = true;
    },
    replaceOriginalTabBeforeFirstActivation: () => {
      replaceOriginalTabBeforeActivation = true;
    },
    escapeAgentNameAfterClose: () => {
      escapeAgentSelectorAfterClose = true;
    },
    failWorkspaceCloseAfterApplying: () => {
      failWorkspaceCloseAfterApply = true;
    },
    blockSnapshotAfterWorkspaceClose: () => {
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
  };
};
