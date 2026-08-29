// Stateful Herdr topology fixture shared by host integration suites.
import * as Effect from "effect/Effect";
import type { HerdrAgent, HerdrCliContract, HerdrSnapshot } from "../../src/boundary/herdr-cli.ts";
import type {
  HerdrStartupReceipt,
  HerdrStartupReceiptPhase,
} from "../../src/boundary/herdr-attestation.ts";
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

const startupReceiptPhases: ReadonlyArray<HerdrStartupReceiptPhase> = [
  "activation-1",
  "activation-2",
  "environment-ready",
  "post-environment-shell",
  "secret-ready",
  "post-secret-shell",
];
const isStartupReceiptPhase = (value: string): value is HerdrStartupReceiptPhase =>
  startupReceiptPhases.some((phase) => phase === value);

export const launch = (id: string): BackendLaunchRequest => ({
  runId: id,
  name: id,
  closeOnReport: false,
  cwd: "/project",
  context: "fresh",
  writeIntent: "read-only",
  openaiFastMode: false,
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
  const publishedReceipts = new Set<HerdrStartupReceiptPhase>();
  const receiptFaults = new Map<
    HerdrStartupReceiptPhase,
    "absent" | "wrong" | "symlink" | "partial"
  >();
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
  let focusedWorkspaceId: string | undefined = "user";
  let focusedTabId: string | undefined = "user:t";
  let focusedPaneId: string | undefined = "user:p0";
  let invalidSecretAttestation = false;
  let dropFirstActivationReceipt = true;
  let dropAllActivationProbes = false;
  let rejectStartAsBusy = false;
  let initialBusyShellInspections = 0;
  let transientPostActivationOccupancySnapshots = 0;
  let configuredPostActivationOccupancySnapshots = 0;
  let postActivationOccupancyPaneId: string | undefined;
  let replaceTerminalDuringShellInspection = false;
  let transientTerminalMismatchSnapshots = 0;
  let driftAfterOutput: "confirm pane input" | "confirm pane environment" | undefined;
  let validSecretBootstrap = false;
  let switchFocusAfterFirstProbe = false;
  let duplicateSelector: "workspace" | "tab" | "terminal" | undefined;
  let splitReturnsForeignPane = false;
  let processInfoReturnsWrongPane = false;
  let startReturnsMismatchedAgent = false;
  let agentNameCollision = false;
  let duplicateNameAfterStart = false;
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

  const observeReceipt = (
    phase: HerdrStartupReceiptPhase,
  ): Effect.Effect<void, SubagentProcessError> =>
    Effect.suspend(() => {
      if (phase === "activation-1" || phase === "activation-2") {
        const paneId = `user:p${(nextPane - 1).toString()}`;
        const attempts = (activationConfirmations.get(paneId) ?? 0) + 1;
        activationConfirmations.set(paneId, attempts);
        if (!publishedReceipts.has(phase)) {
          if (attempts === 1 && switchFocusAfterFirstProbe) {
            focusedTabId = "user:other";
            focusedPaneId = undefined;
          }
          return Effect.fail(
            new SubagentProcessError({
              operation: "observe Herdr startup receipt",
              code: "herdr_startup_receipt_timeout",
              message: "Fixture activation receipt remained absent.",
            }),
          );
        }
        if (attempts > 1 && configuredPostActivationOccupancySnapshots > 0) {
          postActivationOccupancyPaneId = paneId;
          transientPostActivationOccupancySnapshots = configuredPostActivationOccupancySnapshots;
        }
        if (driftAfterOutput === "confirm pane input") transientTerminalMismatchSnapshots = 1;
      }
      const fault = receiptFaults.get(phase);
      if (fault && fault !== "absent")
        return Effect.fail(
          new SubagentProcessError({
            operation: "validate Herdr startup receipt",
            code: "herdr_startup_receipt_invalid",
            message: `Fixture ${fault} receipt was rejected.`,
          }),
        );
      if (!publishedReceipts.has(phase))
        return Effect.fail(
          new SubagentProcessError({
            operation: "observe Herdr startup receipt",
            code: "herdr_startup_receipt_timeout",
            message: "Fixture receipt remained absent.",
          }),
        );
      if (phase === "environment-ready") {
        const paneId = `user:p${(nextPane - 1).toString()}`;
        environmentMarkerInspections.set(paneId, shellProcessInspections.get(paneId) ?? 0);
        if (driftAfterOutput === "confirm pane environment") transientTerminalMismatchSnapshots = 1;
      }
      return Effect.void;
    });

  const fixtureReceipt = (phase: HerdrStartupReceiptPhase): HerdrStartupReceipt => ({
    phase,
    command: `publish-receipt:${phase}`,
    path: `/private/${phase}.receipt`,
    temporaryPath: `/private/${phase}.tmp`,
    observe: observeReceipt(phase),
  });
  const startupAttestation = {
    activationReceipt: (attempt: 1 | 2) =>
      fixtureReceipt(attempt === 1 ? "activation-1" : "activation-2"),
    environmentReadyReceipt: fixtureReceipt("environment-ready"),
    postEnvironmentShellReceipt: fixtureReceipt("post-environment-shell"),
    secretReadyReceipt: fixtureReceipt("secret-ready"),
    postSecretShellReceipt: fixtureReceipt("post-secret-shell"),
  };

  const snapshot = (): HerdrSnapshot => {
    const showTerminalMismatch = transientTerminalMismatchSnapshots > 0;
    transientTerminalMismatchSnapshots = Math.max(0, transientTerminalMismatchSnapshots - 1);
    const showPostActivationOccupancy = transientPostActivationOccupancySnapshots > 0;
    transientPostActivationOccupancySnapshots = Math.max(
      0,
      transientPostActivationOccupancySnapshots - 1,
    );
    return {
      version: "0.8.2",
      protocol: 20,
      focusedWorkspaceId,
      focusedTabId,
      focusedPaneId,
      workspaces: [
        {
          workspaceId: "user",
          label: "user",
          focused: focusedWorkspaceId === "user",
          activeTabId: focusedTabId ?? "user:t",
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
              focused: paneId === focusedPaneId,
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
        publishedReceipts.clear();
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
    runPaneCommand: (paneId, command, operation) =>
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
              message: "Fixture requires fresh shell inspection after the environment receipt.",
            }),
          );
        paneCommands.push({ paneId, operation });
        if (!shellInspectedPanes.has(paneId))
          return Effect.fail(
            new SubagentProcessError({
              operation: "activate pane input",
              code: "fixture_input_before_shell_ready",
              message: "Fixture rejects input while a transient native TUI still owns the pane.",
            }),
          );
        const commandPhase = command.startsWith("publish-receipt:")
          ? command.slice("publish-receipt:".length)
          : undefined;
        const phase =
          commandPhase && isStartupReceiptPhase(commandPhase)
            ? commandPhase
            : operation === "prepare pane environment"
              ? "environment-ready"
              : operation === "load pane secrets"
                ? "secret-ready"
                : undefined;
        if (phase) {
          const shouldDrop =
            receiptFaults.get(phase) === "absent" ||
            ((phase === "activation-1" || phase === "activation-2") &&
              (dropAllActivationProbes ||
                (phase === "activation-1" && dropFirstActivationReceipt)));
          if (!shouldDrop) publishedReceipts.add(phase);
        }
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
        startApplied = true;
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
        const wasFocused = focusedPaneId === paneId;
        closedPanes.push(paneId);
        agents.delete(paneId);
        panes.delete(paneId);
        if (wasFocused) focusedPaneId = [...panes.keys()][0];
        if (escapeAgentSelectorAfterClose) escapedAgentName = closedAgentName;
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
          startupAttestation,
          ...(invalidSecretAttestation
            ? { secretCommand: "" }
            : validSecretBootstrap
              ? { secretCommand: "load-secret" }
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
    publishedReceipts,
    shellProcessInspections,
    shellInspectedPanes,
    closedPanes,
    paneCommands,
    focusOperations,
    splitCalls: () => splitCalls,
    splitTargets: () => [...splitTargets],
    cleanupAuthorizations: () => cleanupAuthorizations,
    focusedTopology: () => ({
      workspaceId: focusedWorkspaceId,
      tabId: focusedTabId,
      paneId: focusedPaneId,
    }),
    callerPaneId: "user:p0",
    callerPaneLive: () => panes.has("user:p0"),
    dropEveryActivationProbe: () => {
      dropAllActivationProbes = true;
    },
    executeFirstActivationReceipt: () => {
      dropFirstActivationReceipt = false;
    },
    failReceipt: (
      phase: HerdrStartupReceiptPhase,
      fault: "absent" | "wrong" | "symlink" | "partial",
    ) => {
      receiptFaults.set(phase, fault);
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
    driftAfterMarker: (operation: "confirm pane input" | "confirm pane environment") => {
      driftAfterOutput = operation;
    },
    enableSecretBootstrap: () => {
      validSecretBootstrap = true;
    },
    switchToOtherTabAfterFirstProbe: () => {
      switchFocusAfterFirstProbe = true;
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
    focusPaneAsUser: (paneId: string) => {
      if (!panes.has(paneId)) throw new Error(`Fixture pane ${paneId} does not exist.`);
      focusedWorkspaceId = "user";
      focusedTabId = "user:t";
      focusedPaneId = paneId;
    },
    switchToOtherTab: () => {
      focusedWorkspaceId = "user";
      focusedTabId = "user:other";
      focusedPaneId = undefined;
    },
    mismatchCurrentPane: () => {
      currentPaneMismatch = true;
    },
    removeCallerPane: () => {
      panes.delete("user:p0");
      if (focusedPaneId === "user:p0") focusedPaneId = undefined;
    },
  };
};
