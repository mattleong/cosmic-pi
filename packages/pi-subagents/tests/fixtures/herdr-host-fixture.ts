// Stateful Herdr topology fixture shared by host integration suites.
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import {
  HerdrCli,
  type HerdrAgent,
  type HerdrCliContract,
  type HerdrSnapshot,
} from "../../src/boundary/herdr-cli.ts";
import type {
  HerdrStartupReceipt,
  HerdrStartupReceiptPhase,
} from "../../src/boundary/herdr-attestation.ts";
import { HerdrHarness, type HerdrHarnessContract } from "../../src/boundary/herdr-harness.ts";
import { HerdrHost, type HerdrHostContract } from "../../src/boundary/herdr-host.ts";
import { supervisorMetadata } from "./backend-supervisor.ts";
import type { BackendLaunchRequest } from "../../src/backend/model.ts";
import type { SubagentRuntime } from "../../src/domain/routing.ts";
import { processError, type SubagentProcessError } from "../../src/run/errors.ts";

export const supervisor = supervisorMetadata({
  stateDirectory: "/private",
  connectionConfigPath: "/private/connection.json",
  tomlFragment: "[mcp_servers.pi_subagents_supervisor]",
});

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

const fixtureFailure = (operation: string, code: string, message: string) =>
  Effect.fail(processError(operation, code, message));

/** A pane outside the caller's workspace whose selectors all derive from `prefix`. */
const foreignPane = (prefix: string, agentStatus: "unknown" | "working" = "unknown") => ({
  paneId: `${prefix}:p`,
  terminalId: `${prefix}:t`,
  workspaceId: `${prefix}:w`,
  tabId: `${prefix}:t`,
  cwd: `/${prefix}`,
  foregroundCwd: `/${prefix}`,
  agentStatus,
});
const foreignAgent = (prefix: string, name: string): HerdrAgent => ({
  ...foreignPane(prefix, "working"),
  name,
  runtime: "pi",
  stateChangeSequence: 1,
});

/** A one-shot snapshot barrier that reports when it is reached and resumes on release. */
const snapshotGate = (read: () => HerdrSnapshot) => {
  let armed = false;
  let reached = false;
  let notify: (() => void) | undefined;
  let release: (() => void) | undefined;
  return {
    arm: () => {
      armed = true;
      reached = false;
      notify = undefined;
    },
    take: () => {
      if (!armed) return undefined;
      armed = false;
      return Effect.callback<HerdrSnapshot>((resume) => {
        reached = true;
        notify?.();
        release = () => resume(Effect.succeed(read()));
      });
    },
    awaitReached: () =>
      Effect.callback<void>((resume) => {
        if (reached) resume(Effect.void);
        else notify = () => resume(Effect.void);
      }),
    release: () => release?.(),
  };
};

export const fakeTopology = () => {
  let nextPane = 1;
  let splitCalls = 0;
  const splitTargets: string[] = [];
  const panes = new Map<string, { terminalId: string }>([
    ["user:p0", { terminalId: "user:term0" }],
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
  /** One-shot faults a test switches on with `inject` before acting. */
  const faults = {
    omitAgentSession: false,
    invalidSecretAttestation: false,
    dropAllActivationProbes: false,
    rejectStartAsBusy: false,
    replaceTerminalDuringShellInspection: false,
    validSecretBootstrap: false,
    switchFocusAfterFirstProbe: false,
    splitReturnsForeignPane: false,
    processInfoReturnsWrongPane: false,
    startReturnsMismatchedAgent: false,
    agentNameCollision: false,
    duplicateNameAfterStart: false,
    replaceOriginalTabBeforeActivation: false,
    escapeAgentSelectorAfterClose: false,
    failPaneCloseAfterApply: false,
    currentPaneMismatch: false,
  };
  let failStartAfterApply = false;
  let failRollbackSnapshot = false;
  let startApplied = false;
  let focusedWorkspaceId: string | undefined = "user";
  let focusedTabId: string | undefined = "user:t";
  let focusedPaneId: string | undefined = "user:p0";
  let dropFirstActivationReceipt = true;
  let initialBusyShellInspections = 0;
  let transientPostActivationOccupancySnapshots = 0;
  let configuredPostActivationOccupancySnapshots = 0;
  let postActivationOccupancyPaneId: string | undefined;
  let transientTerminalMismatchSnapshots = 0;
  let driftAfterOutput: "confirm pane input" | "confirm pane environment" | undefined;
  let duplicateSelector: "workspace" | "tab" | "terminal" | undefined;
  let plannedAgentName: string | undefined;
  let escapedAgentName: string | undefined;
  let replaceOriginalTabIdentity = false;

  const observeReceipt = (
    phase: HerdrStartupReceiptPhase,
  ): Effect.Effect<void, SubagentProcessError> =>
    Effect.suspend(() => {
      if (phase === "activation-1" || phase === "activation-2") {
        const paneId = `user:p${(nextPane - 1).toString()}`;
        const attempts = (activationConfirmations.get(paneId) ?? 0) + 1;
        activationConfirmations.set(paneId, attempts);
        if (!publishedReceipts.has(phase)) {
          if (attempts === 1 && faults.switchFocusAfterFirstProbe) {
            focusedTabId = "user:other";
            focusedPaneId = undefined;
          }
          return fixtureFailure(
            "observe Herdr startup receipt",
            "herdr_startup_receipt_timeout",
            "Fixture activation receipt remained absent.",
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
        return fixtureFailure(
          "validate Herdr startup receipt",
          "herdr_startup_receipt_invalid",
          `Fixture ${fault} receipt was rejected.`,
        );
      if (!publishedReceipts.has(phase))
        return fixtureFailure(
          "observe Herdr startup receipt",
          "herdr_startup_receipt_timeout",
          "Fixture receipt remained absent.",
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
      protocol: 20,
      workspaces: [
        { workspaceId: "user" },
        ...(duplicateSelector === "workspace" ? [{ workspaceId: "user" }] : []),
      ],
      tabs: [
        {
          tabId: "user:t",
          workspaceId: replaceOriginalTabIdentity ? "replacement-user" : "user",
        },
        ...(duplicateSelector === "tab"
          ? [{ tabId: "user:t", workspaceId: "replacement-workspace" }]
          : []),
        { tabId: "user:other", workspaceId: "user" },
      ],
      panes: [
        ...[...panes].map(([paneId, pane]) => ({
          paneId,
          terminalId: showTerminalMismatch ? `${pane.terminalId}-replacement` : pane.terminalId,
          workspaceId: "user",
          tabId: "user:t",
          cwd: "/project",
          foregroundCwd: "/project",
          agentStatus: agents.get(paneId)?.agentStatus ?? "unknown",
        })),
        ...(duplicateSelector === "terminal" && panes.size > 0
          ? [
              {
                paneId: "replacement:p",
                terminalId: [...panes.values()][0]!.terminalId,
                workspaceId: "replacement-workspace",
                tabId: "replacement-tab",
                cwd: "/replacement",
                foregroundCwd: "/replacement",
                agentStatus: "unknown" as const,
              },
            ]
          : []),
      ],
      agents: [
        ...[...agents.values()].map((agent) => ({ ...agent })),
        ...[...panes]
          .filter(
            ([paneId]) => showPostActivationOccupancy && paneId === postActivationOccupancyPaneId,
          )
          .map(([paneId, pane]) => ({
            paneId,
            terminalId: pane.terminalId,
            workspaceId: "user",
            tabId: "user:t",
            cwd: "/project",
            foregroundCwd: "/project",
            agentStatus: "unknown" as const,
            name: "transient-codex-detection",
            runtime: "codex" as const,
            stateChangeSequence: 1,
          })),
        ...(faults.agentNameCollision && plannedAgentName
          ? [foreignAgent("foreign", plannedAgentName)]
          : []),
        ...(escapedAgentName ? [foreignAgent("escaped", escapedAgentName)] : []),
      ],
    };
  };
  const preSplit = snapshotGate(snapshot);
  const postSplit = snapshotGate(snapshot);
  const postClose = snapshotGate(snapshot);
  const cli: HerdrCliContract = {
    callingPaneId: "user:p0",
    preflight: () => Effect.void,
    snapshot: Effect.suspend(() => {
      const gate = splitCalls === 0 ? preSplit : closedPanes.length === 0 ? postSplit : postClose;
      const blocked = gate.take();
      if (blocked) return blocked;
      return startApplied && failRollbackSnapshot
        ? fixtureFailure(
            "session snapshot",
            "herdr_cli_failed",
            "Fixture rollback snapshot failed.",
          )
        : Effect.succeed(snapshot());
    }),
    currentPane: Effect.sync(() => {
      const pane = snapshot().panes.find((candidate) => candidate.paneId === "user:p0")!;
      return faults.currentPaneMismatch ? { ...pane, paneId: "foreign:p" } : pane;
    }),
    splitPane: (anchorPaneId) =>
      Effect.sync(() => {
        splitCalls += 1;
        splitTargets.push(anchorPaneId);
        if (faults.splitReturnsForeignPane) return foreignPane("foreign");
        if (!panes.has(anchorPaneId))
          throw new Error(`Fixture split anchor ${anchorPaneId} does not exist.`);
        const paneId = `user:p${nextPane}`;
        publishedReceipts.clear();
        panes.set(paneId, { terminalId: `user:term${nextPane}` });
        nextPane += 1;
        const pane = snapshot().panes.find((candidate) => candidate.paneId === paneId)!;
        if (faults.replaceOriginalTabBeforeActivation) replaceOriginalTabIdentity = true;
        return pane;
      }),
    renamePane: () => Effect.void,
    runPaneCommand: (paneId, command, operation) =>
      Effect.suspend(() => {
        if (
          operation === "load pane secrets" &&
          (shellProcessInspections.get(paneId) ?? 0) <=
            (environmentMarkerInspections.get(paneId) ?? 0)
        )
          return fixtureFailure(
            operation,
            "fixture_secret_before_replacement_shell",
            "Fixture requires fresh shell inspection after the environment receipt.",
          );
        paneCommands.push({ paneId, operation });
        if (!shellInspectedPanes.has(paneId))
          return fixtureFailure(
            "activate pane input",
            "fixture_input_before_shell_ready",
            "Fixture rejects input while a transient native TUI still owns the pane.",
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
              (faults.dropAllActivationProbes ||
                (phase === "activation-1" && dropFirstActivationReceipt)));
          if (!shouldDrop) publishedReceipts.add(phase);
        }
        return Effect.void;
      }),
    paneProcessInfo: (paneId) =>
      Effect.sync(() => {
        const inspections = (shellProcessInspections.get(paneId) ?? 0) + 1;
        shellProcessInspections.set(paneId, inspections);
        if (faults.replaceTerminalDuringShellInspection && inspections === 1) {
          const pane = panes.get(paneId)!;
          panes.set(paneId, { ...pane, terminalId: `${pane.terminalId}-replacement` });
        }
        if (inspections <= initialBusyShellInspections)
          return {
            paneId: faults.processInfoReturnsWrongPane ? "foreign:p" : paneId,
            shellPid: 4242,
            foregroundProcessGroupId: 4343,
            foregroundProcesses: [{ pid: 4343, name: "codex" }],
          };
        shellInspectedPanes.add(paneId);
        return {
          paneId: faults.processInfoReturnsWrongPane ? "foreign:p" : paneId,
          shellPid: 4242,
          foregroundProcessGroupId: 4242,
          foregroundProcesses: [{ pid: 4242, name: "zsh" }],
        };
      }),
    startAgent: ({ runtime, paneId, agentName }) =>
      Effect.suspend(() => {
        if (!shellInspectedPanes.has(paneId))
          return fixtureFailure(
            "start agent",
            "fixture_shell_not_inspected",
            "Fixture requires shell readiness inspection before start.",
          );
        if (faults.rejectStartAsBusy)
          return fixtureFailure(
            "start agent",
            "agent_pane_busy",
            "Fixture rejects start before application because the pane is busy.",
          );
        const pane = snapshot().panes.find((candidate) => candidate.paneId === paneId)!;
        const agent: HerdrAgent = {
          ...pane,
          agentStatus: "working",
          name: agentName,
          runtime,
          stateChangeSequence: 1,
          interactiveReady: true,
          ...(faults.omitAgentSession
            ? undefined
            : {
                agentSession: {
                  source: "fixture",
                  agent: runtime,
                  kind: "id" as const,
                  value: `native-${paneId}`,
                },
              }),
        };
        agents.set(paneId, agent);
        if (faults.duplicateNameAfterStart) faults.agentNameCollision = true;
        startApplied = true;
        return failStartAfterApply
          ? fixtureFailure(
              "start agent",
              "herdr_start_agent_outcome_uncertain",
              "Fixture start applied before response failure.",
            )
          : Effect.succeed(
              faults.startReturnsMismatchedAgent
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
        if (faults.escapeAgentSelectorAfterClose) escapedAgentName = closedAgentName;
        return faults.failPaneCloseAfterApply
          ? fixtureFailure(
              "close pane",
              "herdr_close_pane_outcome_uncertain",
              "Fixture applied pane close before losing its response.",
            )
          : Effect.void;
      }),
  };
  let cleanupAuthorizations = 0;
  let cleanupWithholds = 0;
  let harnessCleanups = 0;
  const harness: HerdrHarnessContract = {
    preflight: () => Effect.void,
    prepare: (runtime, request) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          let cleanupAllowed = true;
          plannedAgentName = request.name;
          const prepared = {
            directory: `/private/${runtime}`,
            runtime,
            argv: [],
            environmentCommand: () => "fixed-env",
            startupAttestation,
            ...(faults.invalidSecretAttestation
              ? { secretCommand: "" }
              : faults.validSecretBootstrap
                ? { secretCommand: "load-secret" }
                : {}),
            withholdCleanup: () => {
              cleanupAllowed = false;
              cleanupWithholds += 1;
            },
            authorizeCleanup: () => {
              cleanupAllowed = true;
              cleanupAuthorizations += 1;
            },
          };
          return { prepared, cleanupAllowed: () => cleanupAllowed };
        }),
        (owned) =>
          Effect.sync(() => {
            if (owned.cleanupAllowed()) harnessCleanups += 1;
          }),
      ).pipe(Effect.map((owned) => owned.prepared)),
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
    splitCalls: () => splitCalls,
    splitTargets: () => [...splitTargets],
    cleanupAuthorizations: () => cleanupAuthorizations,
    cleanupWithholds: () => cleanupWithholds,
    harnessCleanups: () => harnessCleanups,
    focusedTopology: () => ({
      workspaceId: focusedWorkspaceId,
      tabId: focusedTabId,
      paneId: focusedPaneId,
    }),
    callerPaneId: "user:p0",
    callerPaneLive: () => panes.has("user:p0"),
    inject: (fault: keyof typeof faults) => {
      faults[fault] = true;
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
    driftAfterMarker: (operation: "confirm pane input" | "confirm pane environment") => {
      driftAfterOutput = operation;
    },
    injectDuplicateSelector: (selector: "workspace" | "tab" | "terminal") => {
      duplicateSelector = selector;
    },
    blockSnapshotBeforeSplit: preSplit.arm,
    awaitBlockedPreSplitSnapshot: preSplit.awaitReached,
    blockSnapshotAfterSplit: postSplit.arm,
    awaitBlockedPostSplitSnapshot: postSplit.awaitReached,
    blockSnapshotAfterPaneClose: postClose.arm,
    awaitBlockedPostCloseSnapshot: postClose.awaitReached,
    releaseBlockedPostCloseSnapshot: postClose.release,
    failAppliedStartAndRollbackSnapshot: () => {
      failStartAfterApply = true;
      failRollbackSnapshot = true;
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
    removeCallerPane: () => {
      panes.delete("user:p0");
      if (focusedPaneId === "user:p0") focusedPaneId = undefined;
    },
  };
};

export const hostLayer = (fake: ReturnType<typeof fakeTopology>) =>
  HerdrHost.layer.pipe(
    Layer.provide(
      Layer.merge(Layer.succeed(HerdrCli, fake.cli), Layer.succeed(HerdrHarness, fake.harness)),
    ),
  );

export const launchRun = (host: HerdrHostContract, id: string, runtime: SubagentRuntime = "pi") =>
  host.launch(runtime, launch(id), supervisor);

/** Launches into a caller-owned run scope and returns the launch exit plus that scope's close. */
export const launchInRunScope = (host: HerdrHostContract, id: string) =>
  Effect.gen(function* () {
    const runScope = yield* Scope.make();
    const launched = yield* launchRun(host, id).pipe(
      Effect.provideService(Scope.Scope, runScope),
      Effect.exit,
    );
    return { launched, closeRunScope: Scope.close(runScope, Exit.void).pipe(Effect.exit) };
  });
