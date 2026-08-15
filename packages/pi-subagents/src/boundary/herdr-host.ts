// Herdr-safe agent names use a bounded digest of parent/run ownership identity.
// @effect-diagnostics effect/nodeBuiltinImport:off
import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import {
  agentOwnershipEvidence,
  matchingAgentIdentity,
  matchingPaneIdentity,
  sameAgentOwnership,
  sameAgentSession,
  sameStartedAgent,
  type HerdrAgentOwnershipEvidence as AgentOwnershipEvidence,
} from "../backend/herdr-ownership.ts";
import type { BackendLaunchRequest } from "../backend/model.ts";
import {
  InvalidSubagentRequestError,
  isCleanupUnconfirmed,
  isOutcomeUncertain,
  SubagentProcessError,
} from "../run/errors.ts";
import type { SubagentRuntime } from "../domain/routing.ts";
import {
  HerdrCli,
  type HerdrAgent,
  type HerdrAgentSession,
  type HerdrPane,
  type HerdrSnapshot,
} from "./herdr-cli.ts";
import { HerdrHarness, type HerdrPreparedHarness } from "./herdr-harness.ts";
import { makeHerdrLaunchSafety } from "./herdr-launch-safety.ts";
import type { SupervisorConnectionMetadata } from "./supervisor-channel.ts";

const MAX_LABEL_CHARS = 80;
const MAX_AGENT_NAME_CHARS = 32;
const AGENT_NAME_DIGEST_CHARS = 8;

export interface HerdrHostedAgent {
  readonly runId: string;
  readonly runtime: SubagentRuntime;
  readonly agentName: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly nativeSession: string;
  readonly agentSession: HerdrAgentSession;
  readonly sessionIdentity: string;
  readonly inspect: Effect.Effect<HerdrAgent, SubagentProcessError>;
  readonly prompt: (text: string) => Effect.Effect<HerdrAgent, SubagentProcessError>;
  readonly close: Effect.Effect<void, SubagentProcessError>;
}

export interface HerdrHostShape {
  readonly preflight: (input: {
    readonly runtime: SubagentRuntime;
    readonly context: "fresh" | "fork";
    readonly writeIntent: "read-only" | "writer";
    readonly closeOnReport: boolean;
    readonly model: string;
    readonly effort: import("../domain/routing.ts").SubagentEffort;
    readonly cwd?: string | undefined;
  }) => Effect.Effect<void, InvalidSubagentRequestError>;
  readonly launch: (
    runtime: SubagentRuntime,
    request: BackendLaunchRequest,
    supervisor: SupervisorConnectionMetadata,
  ) => Effect.Effect<HerdrHostedAgent, SubagentProcessError, Scope.Scope>;
}

interface ProjectEvidence {
  readonly workspaceId: string;
  readonly workspaceLabel: string;
  readonly tabId: string;
  readonly tabLabel: string;
  anchorPaneId: string;
}

interface LaunchCleanupOwnership {
  mutationStarted: boolean;
  cleanupConfirmed: boolean;
}

interface ProvisionalLaunchEvidence {
  readonly pane: HerdrPane;
  readonly workspaceCreated: boolean;
  readonly agentName: string;
  readonly runtime: SubagentRuntime;
  ownershipInvalidated: boolean;
  startedIdentity?: AgentOwnershipEvidence | undefined;
  agentStartUncertain?: boolean | undefined;
}

interface OwnedRun {
  readonly runId: string;
  readonly runtime: SubagentRuntime;
  readonly cwd: string;
  readonly agentName: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly nativeSession: string;
  readonly identity: AgentOwnershipEvidence;
  readonly launchCleanup: LaunchCleanupOwnership;
  readonly harness: HerdrPreparedHarness;
  closed: boolean;
  quarantined: boolean;
}

const processError = (operation: string, code: string, message: string) =>
  new SubagentProcessError({ operation, code, message });
const readinessError = (code: string, message: string) =>
  new InvalidSubagentRequestError({ code, message });

const safeIdentityPart = (value: string): string =>
  value
    .replaceAll(/[^A-Za-z0-9_-]/gu, "-")
    .replaceAll(/-+/gu, "-")
    .slice(0, 30) || "session";
const ownedAgentName = (request: BackendLaunchRequest, runtime: SubagentRuntime): string => {
  const prefix = `psa-${runtime}-`;
  const digest = createHash("sha256")
    .update(request.parentSessionId)
    .update("\0")
    .update(request.runId)
    .digest("hex")
    .slice(0, AGENT_NAME_DIGEST_CHARS);
  const readableLimit = MAX_AGENT_NAME_CHARS - prefix.length - digest.length - 1;
  const readable = request.runId
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]/gu, "-")
    .replaceAll(/-+/gu, "-")
    .replaceAll(/^[-_]+|[-_]+$/gu, "")
    .slice(0, readableLimit);
  return `${prefix}${readable || "run"}-${digest}`;
};
const paneLabel = (request: BackendLaunchRequest, runtime: SubagentRuntime): string =>
  `Subagent ${runtime} · ${request.name}`.slice(0, MAX_LABEL_CHARS);
const projectLabel = (request: BackendLaunchRequest): string =>
  `pi-subagents · ${safeIdentityPart(request.parentSessionId)}`.slice(0, MAX_LABEL_CHARS);

const matchingPane = (run: OwnedRun, snapshot: HerdrSnapshot): HerdrPane | undefined =>
  matchingPaneIdentity(run, snapshot);
const matchingAgent = (run: OwnedRun, snapshot: HerdrSnapshot): HerdrAgent | undefined =>
  matchingAgentIdentity(run.identity, run.agentName, snapshot);

const makeHerdrHost = Effect.fn("HerdrHost.make")(function* () {
  const cli = yield* HerdrCli;
  const harnesses = yield* HerdrHarness;
  const lock = yield* Semaphore.make(1);
  const records = new Map<string, OwnedRun>();
  let project: ProjectEvidence | undefined;
  let closed = false;
  const withLock = lock.withPermits(1);

  const exactProject = (snapshot: HerdrSnapshot): ProjectEvidence | undefined => {
    const current = project;
    if (!current) return undefined;
    const workspaceIds = snapshot.workspaces.filter(
      (candidate) => candidate.workspaceId === current.workspaceId,
    );
    const tabIds = snapshot.tabs.filter((candidate) => candidate.tabId === current.tabId);
    const workspace = workspaceIds[0];
    const tab = tabIds[0];
    return workspaceIds.length === 1 &&
      tabIds.length === 1 &&
      workspace?.label === current.workspaceLabel &&
      workspace.activeTabId === current.tabId &&
      tab?.workspaceId === current.workspaceId &&
      tab.label === current.tabLabel
      ? current
      : undefined;
  };

  const ownershipMismatch = (operation: string, message: string) =>
    processError(operation, "herdr_ownership_mismatch", message);
  const provisionalOwnershipMismatch = (operation: string, message: string) =>
    processError(operation, "herdr_provisional_ownership_mismatch", message);

  const {
    inspectProvisionalPane,
    requireAvailableProvisionalPane,
    waitForAvailableShell,
    activatePaneInput,
    confirmShellInput,
    restoreFocus,
  } = makeHerdrLaunchSafety(cli, (snapshot) => exactProject(snapshot) !== undefined);

  const runSelectorsAbsent = (snapshot: HerdrSnapshot, run: OwnedRun): boolean =>
    !snapshot.panes.some(
      (pane) => pane.paneId === run.paneId || pane.terminalId === run.terminalId,
    ) &&
    !snapshot.agents.some(
      (agent) =>
        agent.paneId === run.paneId ||
        agent.terminalId === run.terminalId ||
        agent.name === run.agentName ||
        sameAgentSession(run.identity.agentSession, agent.agentSession),
    );

  const provisionalSelectorsAbsent = (
    snapshot: HerdrSnapshot,
    evidence: ProvisionalLaunchEvidence,
  ): boolean => {
    const agentMayHaveApplied =
      evidence.startedIdentity !== undefined || evidence.agentStartUncertain === true;
    return (
      !snapshot.panes.some(
        (pane) =>
          pane.paneId === evidence.pane.paneId || pane.terminalId === evidence.pane.terminalId,
      ) &&
      !snapshot.agents.some(
        (agent) =>
          agent.paneId === evidence.pane.paneId ||
          agent.terminalId === evidence.pane.terminalId ||
          (agentMayHaveApplied && agent.name === evidence.agentName) ||
          (evidence.startedIdentity !== undefined &&
            sameAgentSession(evidence.startedIdentity.agentSession, agent.agentSession)),
      )
    );
  };

  const quarantineRun = (run: OwnedRun): void => {
    run.quarantined = true;
  };
  const quarantineActiveRuns = (): void => {
    for (const run of records.values()) if (!run.closed) quarantineRun(run);
  };
  const quarantinedRunError = (operation: string) =>
    ownershipMismatch(
      operation,
      "The Herdr run is quarantined after an ownership or cleanup uncertainty; no further mutation was attempted.",
    );

  const inspectOwned = (run: OwnedRun) => {
    if (run.quarantined) return Effect.fail(quarantinedRunError("inspect Herdr agent"));
    return cli.snapshot.pipe(
      Effect.flatMap((snapshot) => {
        if (!exactProject(snapshot)) {
          quarantineRun(run);
          return Effect.fail(
            ownershipMismatch(
              "inspect Herdr agent",
              "The session-owned Herdr workspace/tab identity changed; the agent was not adopted.",
            ),
          );
        }
        const remote = matchingAgent(run, snapshot);
        if (remote) return Effect.succeed(remote);
        quarantineRun(run);
        return Effect.fail(
          ownershipMismatch(
            "inspect Herdr agent",
            "The session-owned Herdr pane/terminal/agent/native-session identity changed.",
          ),
        );
      }),
    );
  };

  const workspaceContainsOnlyOwnedTopology = (
    current: ProjectEvidence,
    snapshot: HerdrSnapshot,
    included: ReadonlyArray<OwnedRun>,
  ): boolean => {
    const tabs = snapshot.tabs.filter((tab) => tab.workspaceId === current.workspaceId);
    const panes = snapshot.panes.filter((pane) => pane.workspaceId === current.workspaceId);
    const agents = snapshot.agents.filter((agent) => agent.workspaceId === current.workspaceId);
    return (
      tabs.length === 1 &&
      tabs[0]?.tabId === current.tabId &&
      panes.length === included.length &&
      agents.length === included.length &&
      included.every(
        (run) =>
          matchingPane(run, snapshot) !== undefined && matchingAgent(run, snapshot) !== undefined,
      )
    );
  };

  const closeOwned = (run: OwnedRun): Effect.Effect<void, SubagentProcessError> =>
    withLock(
      Effect.gen(function* () {
        if (run.closed) return;
        if (run.quarantined) return yield* quarantinedRunError("close Herdr agent");
        const current = records.get(run.runId);
        if (current !== run)
          return yield* ownershipMismatch(
            "close Herdr agent",
            "The run no longer owns its recorded Herdr topology.",
          );
        const before = yield* cli.snapshot;
        const managed = exactProject(before);
        if (!managed) {
          quarantineRun(run);
          return yield* ownershipMismatch(
            "close Herdr agent",
            "The session-owned Herdr workspace/tab identity changed; no topology was closed.",
          );
        }
        if (!matchingAgent(run, before)) {
          quarantineRun(run);
          return yield* ownershipMismatch(
            "close Herdr agent",
            "The exact pane/terminal/agent/native-session identity changed; no topology was closed.",
          );
        }
        const active = [...records.values()].filter((candidate) => !candidate.closed);
        if (active.length === 1) {
          if (!workspaceContainsOnlyOwnedTopology(managed, before, active)) {
            quarantineRun(run);
            return yield* ownershipMismatch(
              "close Herdr workspace",
              "The owned workspace contains unowned or mismatched topology and was not closed.",
            );
          }
          // Close mutation, confirmation snapshot, and ownership-state publication are one
          // interruption-safe commit. Cancellation is observed only after `closed` or quarantine.
          yield* Effect.gen(function* () {
            yield* cli
              .closeWorkspace(managed.workspaceId)
              .pipe(Effect.tapError(() => Effect.sync(() => quarantineRun(run))));
            const after = yield* cli.snapshot.pipe(
              Effect.tapError(() => Effect.sync(() => quarantineRun(run))),
            );
            const workspaceSelectorsRemain =
              after.workspaces.some((workspace) => workspace.workspaceId === managed.workspaceId) ||
              after.tabs.some(
                (tab) => tab.tabId === managed.tabId || tab.workspaceId === managed.workspaceId,
              ) ||
              after.panes.some(
                (pane) => pane.workspaceId === managed.workspaceId || pane.tabId === managed.tabId,
              ) ||
              after.agents.some(
                (agent) =>
                  agent.workspaceId === managed.workspaceId || agent.tabId === managed.tabId,
              ) ||
              !runSelectorsAbsent(after, run);
            if (workspaceSelectorsRemain) {
              quarantineRun(run);
              return yield* processError(
                "close Herdr workspace",
                "herdr_cleanup_unconfirmed",
                "Herdr acknowledged workspace closure, but an owned workspace/tab/pane/terminal/agent selector remains visible.",
              );
            }
            records.delete(run.runId);
            run.closed = true;
            run.launchCleanup.cleanupConfirmed = true;
            project = undefined;
            run.harness.authorizeCleanup();
          }).pipe(Effect.uninterruptible);
          yield* restoreFocus(before, managed.tabId);
          return;
        }
        yield* Effect.gen(function* () {
          yield* cli
            .closePane(run.paneId)
            .pipe(Effect.tapError(() => Effect.sync(() => quarantineRun(run))));
          const after = yield* cli.snapshot.pipe(
            Effect.tapError(() => Effect.sync(() => quarantineRun(run))),
          );
          if (!runSelectorsAbsent(after, run)) {
            quarantineRun(run);
            return yield* processError(
              "close Herdr pane",
              "herdr_cleanup_unconfirmed",
              "Herdr acknowledged pane closure, but an owned pane/terminal/agent-name selector remains visible.",
            );
          }
          records.delete(run.runId);
          run.closed = true;
          run.launchCleanup.cleanupConfirmed = true;
          run.harness.authorizeCleanup();
          if (managed.anchorPaneId === run.paneId) {
            const replacement = [...records.values()].find((candidate) => !candidate.closed);
            if (replacement) managed.anchorPaneId = replacement.paneId;
          }
        }).pipe(Effect.uninterruptible);
        yield* restoreFocus(before, managed.tabId);
      }),
    );

  const rollbackProvisional = (
    evidence: ProvisionalLaunchEvidence,
    harness: HerdrPreparedHarness,
  ): Effect.Effect<void, SubagentProcessError> =>
    Effect.gen(function* () {
      const snapshot = yield* cli.snapshot;
      const managed = exactProject(snapshot);
      if (!managed)
        return yield* ownershipMismatch(
          "rollback Herdr launch",
          "Provisional Herdr project ownership could not be revalidated; cleanup was refused.",
        );
      const pane = matchingPaneIdentity(evidence.pane, snapshot);
      const agentMayHaveApplied =
        evidence.startedIdentity !== undefined || evidence.agentStartUncertain === true;
      const occupants = snapshot.agents.filter(
        (agent) =>
          agent.paneId === evidence.pane.paneId ||
          agent.terminalId === evidence.pane.terminalId ||
          (agentMayHaveApplied && agent.name === evidence.agentName) ||
          (evidence.startedIdentity !== undefined &&
            sameAgentSession(evidence.startedIdentity.agentSession, agent.agentSession)),
      );
      const occupant = occupants[0];
      if (
        !pane ||
        occupants.length > 1 ||
        (evidence.agentStartUncertain && !evidence.startedIdentity) ||
        (occupant !== undefined &&
          (!evidence.startedIdentity || !sameAgentOwnership(evidence.startedIdentity, occupant)))
      )
        return yield* ownershipMismatch(
          "rollback Herdr launch",
          "Provisional Herdr pane occupancy changed; cleanup was refused.",
        );
      if (evidence.workspaceCreated) {
        const tabs = snapshot.tabs.filter((tab) => tab.workspaceId === managed.workspaceId);
        const panes = snapshot.panes.filter(
          (candidate) => candidate.workspaceId === managed.workspaceId,
        );
        if (tabs.length !== 1 || panes.length !== 1)
          return yield* ownershipMismatch(
            "rollback Herdr workspace",
            "Provisional Herdr workspace topology changed; cleanup was refused.",
          );
        yield* cli.closeWorkspace(managed.workspaceId);
        const after = yield* cli.snapshot;
        const workspaceSelectorsRemain =
          after.workspaces.some((workspace) => workspace.workspaceId === managed.workspaceId) ||
          after.tabs.some(
            (tab) => tab.tabId === managed.tabId || tab.workspaceId === managed.workspaceId,
          ) ||
          after.panes.some(
            (candidate) =>
              candidate.workspaceId === managed.workspaceId || candidate.tabId === managed.tabId,
          ) ||
          after.agents.some(
            (agent) => agent.workspaceId === managed.workspaceId || agent.tabId === managed.tabId,
          ) ||
          !provisionalSelectorsAbsent(after, evidence);
        if (workspaceSelectorsRemain)
          return yield* processError(
            "rollback Herdr workspace",
            "herdr_cleanup_unconfirmed",
            "Provisional workspace cleanup left an owned workspace/tab/pane/terminal/agent selector visible.",
          );
        project = undefined;
      } else {
        yield* cli.closePane(pane.paneId);
        const after = yield* cli.snapshot;
        if (!provisionalSelectorsAbsent(after, evidence))
          return yield* processError(
            "rollback Herdr pane",
            "herdr_cleanup_unconfirmed",
            "Provisional pane cleanup left an owned pane/terminal/agent-name selector visible.",
          );
      }
      harness.authorizeCleanup();
    });

  const acquire = (
    runtime: SubagentRuntime,
    request: BackendLaunchRequest,
    supervisor: SupervisorConnectionMetadata,
  ) =>
    withLock(
      Effect.gen(function* () {
        if (closed)
          return yield* processError(
            "launch Herdr agent",
            "herdr_host_closed",
            "The parent Herdr host is closed.",
          );
        const agentName = ownedAgentName(request, runtime);
        const harness = yield* harnesses.prepare(
          runtime,
          { ...request, name: agentName },
          supervisor,
        );
        const hasSecretCommand = harness.secretCommand !== undefined;
        const hasSecretMarker = harness.secretReadyMarker !== undefined;
        if (
          hasSecretCommand !== hasSecretMarker ||
          harness.secretCommand === "" ||
          harness.secretReadyMarker === ""
        ) {
          harness.authorizeCleanup();
          return yield* processError(
            "validate Herdr harness",
            "herdr_secret_attestation_invalid",
            "Private Herdr secret bootstrap command and readiness marker must be present together and non-empty.",
          );
        }
        const before = yield* cli.snapshot.pipe(
          Effect.tapError(() => Effect.sync(() => harness.authorizeCleanup())),
        );
        const launchCleanup: LaunchCleanupOwnership = {
          mutationStarted: false,
          cleanupConfirmed: false,
        };
        // This guard is installed before the first topology mutation. Unlike acquireRelease's
        // hosted finalizer, it also owns failed acquisitions. Any uncertain mutation or refused
        // rollback therefore makes scope close fail and keeps the outer process/lease slots
        // quarantined.
        yield* Effect.addFinalizer(() => {
          if (!launchCleanup.mutationStarted) {
            harness.authorizeCleanup();
            return Effect.void;
          }
          return !launchCleanup.cleanupConfirmed
            ? Effect.fail(
                processError(
                  "finalize Herdr launch",
                  "herdr_launch_cleanup_unconfirmed",
                  "Herdr launch topology or process cleanup remains uncertain.",
                ),
              ).pipe(Effect.orDie)
            : Effect.void;
        });
        const markDefiniteNonApplication = (error: SubagentProcessError) =>
          Effect.sync(() => {
            if (!isOutcomeUncertain(error) && !isCleanupUnconfirmed(error)) {
              launchCleanup.cleanupConfirmed = true;
              harness.authorizeCleanup();
            }
          });
        let workspaceCreated = false;
        let ownershipInvalidated = false;
        let pane: HerdrPane;
        if (!project) {
          launchCleanup.mutationStarted = true;
          const created = yield* cli
            .createWorkspace(request.cwd, projectLabel(request))
            .pipe(Effect.tapError(markDefiniteNonApplication));
          project = {
            workspaceId: created.workspaceId,
            workspaceLabel: created.workspaceLabel,
            tabId: created.tabId,
            tabLabel: created.tabLabel,
            anchorPaneId: created.rootPane.paneId,
          };
          workspaceCreated = true;
          pane = created.rootPane;
          ownershipInvalidated =
            before.workspaces.some((workspace) => workspace.workspaceId === created.workspaceId) ||
            before.tabs.some((tab) => tab.tabId === created.tabId) ||
            before.panes.some(
              (candidate) =>
                candidate.workspaceId === created.workspaceId ||
                candidate.tabId === created.tabId ||
                candidate.paneId === pane.paneId ||
                candidate.terminalId === pane.terminalId,
            ) ||
            before.agents.some(
              (agent) =>
                agent.workspaceId === created.workspaceId ||
                agent.tabId === created.tabId ||
                agent.paneId === pane.paneId ||
                agent.terminalId === pane.terminalId,
            );
        } else {
          const managed = exactProject(before);
          if (!managed) {
            quarantineActiveRuns();
            return yield* ownershipMismatch(
              "launch Herdr agent",
              "The shared session-owned Herdr workspace/tab identity changed; no pane was created and existing runs were quarantined.",
            );
          }
          const anchorCandidates = before.panes.filter(
            (candidate) =>
              candidate.paneId === managed.anchorPaneId &&
              candidate.workspaceId === managed.workspaceId &&
              candidate.tabId === managed.tabId,
          );
          const anchor =
            anchorCandidates.length === 1
              ? matchingPaneIdentity(anchorCandidates[0]!, before)
              : undefined;
          const anchorRun = [...records.values()].find(
            (candidate) => !candidate.closed && candidate.paneId === managed.anchorPaneId,
          );
          if (!anchor || !anchorRun || anchorRun.quarantined || !matchingAgent(anchorRun, before)) {
            quarantineActiveRuns();
            return yield* ownershipMismatch(
              "launch Herdr agent",
              "The shared session-owned Herdr anchor pane/agent/session identity changed or was quarantined; no pane was created.",
            );
          }
          launchCleanup.mutationStarted = true;
          pane = yield* cli
            .splitPane(anchor.paneId, request.cwd)
            .pipe(Effect.tapError(markDefiniteNonApplication));
          ownershipInvalidated =
            before.panes.some(
              (candidate) =>
                candidate.paneId === pane.paneId || candidate.terminalId === pane.terminalId,
            ) ||
            before.agents.some(
              (agent) => agent.paneId === pane.paneId || agent.terminalId === pane.terminalId,
            );
        }
        const provisional: ProvisionalLaunchEvidence = {
          pane,
          workspaceCreated,
          agentName,
          runtime,
          ownershipInvalidated,
        };
        const invalidateProvisional = () => {
          provisional.ownershipInvalidated = true;
        };
        const launch = Effect.gen(function* () {
          const managed = project;
          if (
            provisional.ownershipInvalidated ||
            !managed ||
            pane.workspaceId !== managed.workspaceId ||
            pane.tabId !== managed.tabId
          ) {
            invalidateProvisional();
            return yield* provisionalOwnershipMismatch(
              "launch Herdr agent",
              "Herdr returned topology whose selectors were pre-existing or outside the session-owned workspace/tab.",
            );
          }
          yield* inspectProvisionalPane(pane, "rename pane", invalidateProvisional);
          yield* cli.renamePane(pane.paneId, paneLabel(request, runtime));
          // A restored server can transiently start a stale native agent in a newly created pane.
          // Do not spend either bounded activation probe inside that TUI; wait until the exact pane
          // first reaches an available, unoccupied shell, then causally activate input.
          yield* waitForAvailableShell(pane, invalidateProvisional);
          // The harmless marker may be retried because it has no state beyond terminal output.
          yield* activatePaneInput(before, pane, harness, invalidateProvisional);
          yield* requireAvailableProvisionalPane(
            pane,
            "prepare pane environment",
            true,
            invalidateProvisional,
          );
          yield* cli.runPaneCommand(
            pane.paneId,
            harness.environmentCommand({
              paneId: pane.paneId,
              tabId: pane.tabId,
              workspaceId: pane.workspaceId,
            }),
            "prepare pane environment",
          );
          yield* cli.waitPaneOutput(
            pane.paneId,
            harness.environmentReadyMarker,
            "confirm pane environment",
          );
          // The bootstrap marker precedes its final exec. A queued harmless command must execute
          // in the replacement shell before any private secret input is allowed.
          yield* confirmShellInput(pane, harness, "environment", invalidateProvisional);
          if (harness.secretCommand && harness.secretReadyMarker) {
            // The environment marker precedes its final shell exec. Re-prove foreground-shell
            // ownership before sending credential bootstrap into the pane.
            yield* waitForAvailableShell(pane, invalidateProvisional, true);
            yield* requireAvailableProvisionalPane(
              pane,
              "load pane secrets",
              true,
              invalidateProvisional,
            );
            yield* cli.runPaneCommand(pane.paneId, harness.secretCommand, "load pane secrets");
            yield* cli.waitPaneOutput(
              pane.paneId,
              harness.secretReadyMarker,
              "confirm pane secrets",
            );
            // Prove that the shell accepted another command after secret bootstrap completed.
            yield* confirmShellInput(pane, harness, "secrets", invalidateProvisional);
          }
          // Marker output proves that the sterile environment command was accepted, but it can
          // precede the final exec into the replacement interactive shell. Agent start requires
          // that exact shell to own the foreground while the owned tab remains focused.
          yield* waitForAvailableShell(pane, invalidateProvisional, true);
          yield* requireAvailableProvisionalPane(
            pane,
            "start agent",
            true,
            invalidateProvisional,
            agentName,
          );
          const remote = yield* cli.startAgent({
            runtime,
            paneId: pane.paneId,
            agentName,
            argv: harness.argv,
          });
          provisional.agentStartUncertain = true;
          if (!sameStartedAgent(pane, agentName, runtime, request.cwd, remote)) {
            invalidateProvisional();
            return yield* provisionalOwnershipMismatch(
              "launch Herdr agent",
              "Herdr returned mismatched pane/terminal/agent startup evidence.",
            );
          }
          const identity = agentOwnershipEvidence(remote);
          if (!identity)
            return yield* processError(
              "confirm Herdr agent session",
              "herdr_agent_session_unconfirmed",
              "Herdr confirmed interactive startup without atomically returning bounded native session ownership evidence; protocol 19 exposes no launch token for safe delayed adoption.",
            );
          provisional.startedIdentity = identity;
          const run: OwnedRun = {
            runId: request.runId,
            runtime,
            cwd: request.cwd,
            agentName,
            workspaceId: pane.workspaceId,
            tabId: pane.tabId,
            paneId: pane.paneId,
            terminalId: pane.terminalId,
            nativeSession: identity.agentSession.value,
            identity,
            launchCleanup,
            harness,
            closed: false,
            quarantined: false,
          };
          const validateStartedOwnership = (snapshot: HerdrSnapshot) => {
            if (exactProject(snapshot) && matchingAgent(run, snapshot)) return Effect.void;
            invalidateProvisional();
            return Effect.fail(
              provisionalOwnershipMismatch(
                "confirm Herdr agent ownership",
                "The started agent's unique workspace/tab/pane/terminal/name/session ownership changed before commit.",
              ),
            );
          };
          yield* cli.snapshot.pipe(Effect.flatMap(validateStartedOwnership));
          yield* restoreFocus(before, managed.tabId, validateStartedOwnership);
          records.set(run.runId, run);
          managed.anchorPaneId = run.paneId;
          const hosted: HerdrHostedAgent = {
            runId: run.runId,
            runtime,
            agentName,
            workspaceId: run.workspaceId,
            tabId: run.tabId,
            paneId: run.paneId,
            terminalId: run.terminalId,
            nativeSession: run.nativeSession,
            agentSession: { ...run.identity.agentSession },
            sessionIdentity: cli.sessionIdentity,
            inspect: withLock(inspectOwned(run)),
            prompt: (text) =>
              withLock(
                inspectOwned(run).pipe(
                  Effect.andThen(cli.prompt(run.agentName, text)),
                  Effect.flatMap((result) => {
                    if (sameAgentOwnership(run.identity, result)) return Effect.succeed(result);
                    quarantineRun(run);
                    return Effect.fail(
                      ownershipMismatch(
                        "prompt Herdr agent",
                        "Herdr prompt confirmation named a different owned agent.",
                      ),
                    );
                  }),
                ),
              ),
            close: closeOwned(run),
          };
          return hosted;
        });
        return yield* launch.pipe(
          Effect.catch((error) => {
            if (provisional.ownershipInvalidated)
              return Effect.fail(
                processError(
                  "rollback Herdr launch",
                  "herdr_cleanup_unconfirmed",
                  `${error.message} The observed ownership mismatch is sticky; provisional topology was quarantined without a cleanup mutation.`,
                ),
              );
            if (
              error.operation === "start agent" &&
              (isOutcomeUncertain(error) || isCleanupUnconfirmed(error))
            )
              provisional.agentStartUncertain = true;
            return rollbackProvisional(provisional, harness).pipe(
              Effect.matchEffect({
                onFailure: (cleanup) =>
                  Effect.fail(
                    processError(
                      "rollback Herdr launch",
                      "herdr_cleanup_unconfirmed",
                      `${error.message} Provisional topology cleanup was refused or unconfirmed: ${cleanup.message}`,
                    ),
                  ),
                onSuccess: () =>
                  Effect.sync(() => {
                    launchCleanup.cleanupConfirmed = true;
                  }).pipe(
                    Effect.andThen(
                      restoreFocus(before, provisional.pane.tabId).pipe(
                        Effect.mapError((focusError) =>
                          processError(
                            error.operation,
                            error.code ?? "herdr_launch_failed",
                            `${error.message} Focus restoration also failed: ${focusError.message}`,
                          ),
                        ),
                      ),
                    ),
                    Effect.andThen(Effect.fail(error)),
                  ),
              }),
            );
          }),
        );
      }),
    );

  const launch: HerdrHostShape["launch"] = (runtime, request, supervisor) =>
    Effect.acquireRelease(acquire(runtime, request, supervisor), (hosted) =>
      hosted.close.pipe(Effect.orDie),
    );

  const preflight: HerdrHostShape["preflight"] = (input) =>
    Effect.gen(function* () {
      if (input.context !== "fresh")
        return yield* readinessError(
          "context_unsupported",
          "Every Herdr-hosted runtime supports fresh context only.",
        );
      if (!input.closeOnReport && input.writeIntent !== "read-only")
        return yield* readinessError(
          "retained_writer_unsupported",
          "closeOnReport=false is supported only for read-only Herdr agents.",
        );
      if (!input.cwd)
        return yield* readinessError(
          "herdr_cwd_required",
          "Herdr readiness requires a canonical assigned cwd.",
        );
      yield* cli.preflight(input.runtime);
      yield* harnesses.preflight(input.runtime, {
        cwd: input.cwd,
        writeIntent: input.writeIntent,
        model: input.model,
        effort: input.effort,
      });
    });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      // Each close revalidates exact ownership. A mismatch deliberately defects the dependent
      // run scope so writer leases and process capacity remain quarantined.
      for (const run of [...records.values()].reverse()) yield* closeOwned(run);
    }).pipe(Effect.orDie),
  );

  return HerdrHost.of({ preflight, launch });
});

export class HerdrHost extends Context.Service<HerdrHost, HerdrHostShape>()(
  "pi-subagents/boundary/herdr-host/HerdrHost",
) {
  static readonly layer = Layer.effect(this, makeHerdrHost());
}
