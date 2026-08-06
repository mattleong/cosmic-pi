// Herdr-safe agent names use a bounded digest of parent/run ownership identity.
// @effect-diagnostics effect/nodeBuiltinImport:off
import { createHash } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import type { BackendLaunchRequest } from "../backend/model.ts";
import { InvalidSubagentRequestError, SubagentProcessError } from "../run/errors.ts";
import type { SubagentRuntime } from "../run/model.ts";
import {
  HerdrCli,
  type HerdrAgent,
  type HerdrAgentSession,
  type HerdrPane,
  type HerdrSnapshot,
} from "./herdr-cli.ts";
import { HerdrHarness, type HerdrPreparedHarness } from "./herdr-harness.ts";
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
    readonly effort: import("../run/model.ts").SubagentEffort;
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

interface AgentOwnershipEvidence {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly name: string;
  readonly runtime: string;
  readonly agentSession: HerdrAgentSession;
  readonly cwd?: string | undefined;
  readonly foregroundCwd?: string | undefined;
}

interface LaunchCleanupOwnership {
  mutationStarted: boolean;
  cleanupConfirmed: boolean;
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

const agentOwnershipEvidence = (agent: HerdrAgent): AgentOwnershipEvidence | undefined =>
  agent.name && agent.runtime && agent.agentSession
    ? {
        workspaceId: agent.workspaceId,
        tabId: agent.tabId,
        paneId: agent.paneId,
        terminalId: agent.terminalId,
        name: agent.name,
        runtime: agent.runtime,
        agentSession: { ...agent.agentSession },
        ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
        ...(agent.foregroundCwd === undefined ? {} : { foregroundCwd: agent.foregroundCwd }),
      }
    : undefined;

const sameStartedAgent = (
  pane: HerdrPane,
  agentName: string,
  runtime: SubagentRuntime,
  cwd: string,
  agent: HerdrAgent,
): boolean =>
  agent.paneId === pane.paneId &&
  agent.terminalId === pane.terminalId &&
  agent.workspaceId === pane.workspaceId &&
  agent.tabId === pane.tabId &&
  agent.name === agentName &&
  agent.runtime === runtime &&
  (agent.cwd === cwd || agent.foregroundCwd === cwd) &&
  (agent.agentSession === undefined || agent.agentSession.agent === runtime);

/** One comparator is used for prompt, inspect, rollback, and close ownership decisions. */
const sameAgentOwnership = (expected: AgentOwnershipEvidence, agent: HerdrAgent): boolean => {
  const actual = agentOwnershipEvidence(agent);
  return (
    actual !== undefined &&
    actual.workspaceId === expected.workspaceId &&
    actual.tabId === expected.tabId &&
    actual.paneId === expected.paneId &&
    actual.terminalId === expected.terminalId &&
    actual.name === expected.name &&
    actual.runtime === expected.runtime &&
    actual.cwd === expected.cwd &&
    actual.foregroundCwd === expected.foregroundCwd &&
    actual.agentSession.source === expected.agentSession.source &&
    actual.agentSession.agent === expected.agentSession.agent &&
    actual.agentSession.kind === expected.agentSession.kind &&
    actual.agentSession.value === expected.agentSession.value
  );
};

const matchingPane = (run: OwnedRun, snapshot: HerdrSnapshot): HerdrPane | undefined =>
  snapshot.panes.find(
    (pane) =>
      pane.paneId === run.paneId &&
      pane.terminalId === run.terminalId &&
      pane.workspaceId === run.workspaceId &&
      pane.tabId === run.tabId,
  );
const matchingAgent = (run: OwnedRun, snapshot: HerdrSnapshot): HerdrAgent | undefined => {
  if (!matchingPane(run, snapshot)) return undefined;
  return snapshot.agents.find((agent) => sameAgentOwnership(run.identity, agent));
};

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
    const workspace = snapshot.workspaces.find(
      (candidate) =>
        candidate.workspaceId === current.workspaceId &&
        candidate.label === current.workspaceLabel &&
        candidate.activeTabId === current.tabId,
    );
    const tab = snapshot.tabs.find(
      (candidate) =>
        candidate.tabId === current.tabId &&
        candidate.workspaceId === current.workspaceId &&
        candidate.label === current.tabLabel,
    );
    return workspace && tab ? current : undefined;
  };

  const ownershipMismatch = (operation: string, message: string) =>
    processError(operation, "herdr_ownership_mismatch", message);

  const restoreFocus = (before: HerdrSnapshot, ownedTabId: string) => {
    const previousTab = before.focusedTabId;
    if (!previousTab || previousTab === ownedTabId) return Effect.void;
    return cli.snapshot.pipe(
      Effect.flatMap((after) =>
        after.focusedTabId === ownedTabId && after.tabs.some((tab) => tab.tabId === previousTab)
          ? cli.focusTab(previousTab)
          : Effect.void,
      ),
    );
  };

  const inspectOwned = (run: OwnedRun) =>
    cli.snapshot.pipe(
      Effect.flatMap((snapshot) => {
        if (!exactProject(snapshot))
          return Effect.fail(
            ownershipMismatch(
              "inspect Herdr agent",
              "The session-owned Herdr workspace/tab identity changed; the agent was not adopted.",
            ),
          );
        const remote = matchingAgent(run, snapshot);
        return remote
          ? Effect.succeed(remote)
          : Effect.fail(
              ownershipMismatch(
                "inspect Herdr agent",
                "The session-owned Herdr pane/terminal/agent/native-session identity changed.",
              ),
            );
      }),
    );

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
        const current = records.get(run.runId);
        if (current !== run)
          return yield* ownershipMismatch(
            "close Herdr agent",
            "The run no longer owns its recorded Herdr topology.",
          );
        const before = yield* cli.snapshot;
        const managed = exactProject(before);
        if (!managed)
          return yield* ownershipMismatch(
            "close Herdr agent",
            "The session-owned Herdr workspace/tab identity changed; no topology was closed.",
          );
        if (!matchingAgent(run, before))
          return yield* ownershipMismatch(
            "close Herdr agent",
            "The exact pane/terminal/agent/native-session identity changed; no topology was closed.",
          );
        const active = [...records.values()].filter((candidate) => !candidate.closed);
        if (active.length === 1) {
          if (!workspaceContainsOnlyOwnedTopology(managed, before, active))
            return yield* ownershipMismatch(
              "close Herdr workspace",
              "The owned workspace contains unowned or mismatched topology and was not closed.",
            );
          yield* cli.closeWorkspace(managed.workspaceId);
          const after = yield* cli.snapshot;
          if (after.workspaces.some((workspace) => workspace.workspaceId === managed.workspaceId))
            return yield* processError(
              "close Herdr workspace",
              "herdr_cleanup_unconfirmed",
              "Herdr acknowledged workspace closure, but the owned workspace remains visible.",
            );
          records.delete(run.runId);
          run.closed = true;
          run.launchCleanup.cleanupConfirmed = true;
          project = undefined;
          run.harness.authorizeCleanup();
          yield* restoreFocus(before, managed.tabId);
          return;
        }
        yield* cli.closePane(run.paneId);
        const after = yield* cli.snapshot;
        if (after.panes.some((pane) => pane.paneId === run.paneId))
          return yield* processError(
            "close Herdr pane",
            "herdr_cleanup_unconfirmed",
            "Herdr acknowledged pane closure, but the exact pane remains visible.",
          );
        records.delete(run.runId);
        run.closed = true;
        run.launchCleanup.cleanupConfirmed = true;
        run.harness.authorizeCleanup();
        if (managed.anchorPaneId === run.paneId) {
          const replacement = [...records.values()].find((candidate) => !candidate.closed);
          if (replacement) managed.anchorPaneId = replacement.paneId;
        }
        yield* restoreFocus(before, managed.tabId);
      }),
    );

  const rollbackProvisional = (
    evidence: {
      readonly pane: HerdrPane;
      readonly workspaceCreated: boolean;
      readonly agentName: string;
      readonly runtime: SubagentRuntime;
      readonly startedIdentity?: AgentOwnershipEvidence | undefined;
      readonly agentStartUncertain?: boolean | undefined;
    },
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
      const pane = snapshot.panes.find(
        (candidate) =>
          candidate.paneId === evidence.pane.paneId &&
          candidate.terminalId === evidence.pane.terminalId &&
          candidate.workspaceId === evidence.pane.workspaceId &&
          candidate.tabId === evidence.pane.tabId,
      );
      const occupant = snapshot.agents.find((agent) => agent.paneId === evidence.pane.paneId);
      if (
        !pane ||
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
        if (after.workspaces.some((workspace) => workspace.workspaceId === managed.workspaceId))
          return yield* processError(
            "rollback Herdr workspace",
            "herdr_cleanup_unconfirmed",
            "Provisional Herdr workspace cleanup was not confirmed.",
          );
        project = undefined;
      } else {
        yield* cli.closePane(pane.paneId);
        const after = yield* cli.snapshot;
        if (after.panes.some((candidate) => candidate.paneId === pane.paneId))
          return yield* processError(
            "rollback Herdr pane",
            "herdr_cleanup_unconfirmed",
            "Provisional Herdr pane cleanup was not confirmed.",
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
            if (
              !error.code?.endsWith("_outcome_uncertain") &&
              !error.code?.endsWith("_cleanup_unconfirmed")
            ) {
              launchCleanup.cleanupConfirmed = true;
              harness.authorizeCleanup();
            }
          });
        let workspaceCreated = false;
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
        } else {
          const managed = exactProject(before);
          if (!managed)
            return yield* ownershipMismatch(
              "launch Herdr agent",
              "The shared session-owned Herdr workspace/tab identity changed; no pane was created.",
            );
          const anchor = before.panes.find(
            (candidate) =>
              candidate.paneId === managed.anchorPaneId &&
              candidate.workspaceId === managed.workspaceId &&
              candidate.tabId === managed.tabId,
          );
          if (!anchor)
            return yield* ownershipMismatch(
              "launch Herdr agent",
              "The shared session-owned Herdr anchor pane changed; no pane was created.",
            );
          launchCleanup.mutationStarted = true;
          pane = yield* cli
            .splitPane(anchor.paneId, request.cwd)
            .pipe(Effect.tapError(markDefiniteNonApplication));
        }
        const provisional: {
          readonly pane: HerdrPane;
          readonly workspaceCreated: boolean;
          readonly agentName: string;
          readonly runtime: SubagentRuntime;
          startedIdentity?: AgentOwnershipEvidence | undefined;
          agentStartUncertain?: boolean | undefined;
        } = { pane, workspaceCreated, agentName, runtime };
        const launch = Effect.gen(function* () {
          const managed = project;
          if (!managed || pane.workspaceId !== managed.workspaceId || pane.tabId !== managed.tabId)
            return yield* ownershipMismatch(
              "launch Herdr agent",
              "Herdr created a pane outside the session-owned workspace/tab.",
            );
          yield* cli.renamePane(pane.paneId, paneLabel(request, runtime));
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
          if (harness.secretCommand && harness.secretReadyMarker) {
            yield* cli.runPaneCommand(pane.paneId, harness.secretCommand, "load pane secrets");
            yield* cli.waitPaneOutput(
              pane.paneId,
              harness.secretReadyMarker,
              "confirm pane secrets",
            );
          }
          yield* Effect.sleep("100 millis");
          const remote = yield* cli.startAgent({
            runtime,
            paneId: pane.paneId,
            agentName,
            argv: harness.argv,
          });
          if (!sameStartedAgent(pane, agentName, runtime, request.cwd, remote))
            return yield* ownershipMismatch(
              "launch Herdr agent",
              "Herdr returned mismatched pane/terminal/agent startup evidence.",
            );
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
          };
          yield* restoreFocus(before, managed.tabId);
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
                  Effect.flatMap((result) =>
                    sameAgentOwnership(run.identity, result)
                      ? Effect.succeed(result)
                      : Effect.fail(
                          ownershipMismatch(
                            "prompt Herdr agent",
                            "Herdr prompt confirmation named a different owned agent.",
                          ),
                        ),
                  ),
                ),
              ),
            close: closeOwned(run),
          };
          return hosted;
        });
        return yield* launch.pipe(
          Effect.catch((error) => {
            if (
              error.operation === "start agent" &&
              (error.code?.endsWith("_outcome_uncertain") ||
                error.code?.endsWith("_cleanup_unconfirmed"))
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
                  }).pipe(Effect.andThen(Effect.fail(error))),
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
