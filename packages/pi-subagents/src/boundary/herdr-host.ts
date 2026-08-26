// Herdr-safe agent names use a bounded digest of parent/run ownership identity.
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
  processError,
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

export interface HerdrHostContract {
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

interface LaunchCleanupOwnership {
  mutationStarted: boolean;
  cleanupConfirmed: boolean;
}

interface ProvisionalLaunchEvidence {
  readonly pane: HerdrPane;
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

const readinessError = (code: string, message: string) =>
  new InvalidSubagentRequestError({ code, message });

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

const matchingPane = (run: OwnedRun, snapshot: HerdrSnapshot): HerdrPane | undefined =>
  matchingPaneIdentity(run, snapshot);
const matchingAgent = (run: OwnedRun, snapshot: HerdrSnapshot): HerdrAgent | undefined =>
  matchingAgentIdentity(run.identity, run.agentName, snapshot);

const makeHerdrHost = Effect.fn("HerdrHost.make")(function* () {
  const cli = yield* HerdrCli;
  const harnesses = yield* HerdrHarness;
  const lock = yield* Semaphore.make(1);
  const records = new Map<string, OwnedRun>();
  let closed = false;
  const withLock = lock.withPermits(1);

  const exactPaneContext = (
    pane: Pick<HerdrPane, "paneId" | "terminalId" | "workspaceId" | "tabId">,
    snapshot: HerdrSnapshot,
  ): boolean => {
    if (!matchingPaneIdentity(pane, snapshot)) return false;
    const workspaces = snapshot.workspaces.filter(
      (candidate) => candidate.workspaceId === pane.workspaceId,
    );
    const tabs = snapshot.tabs.filter((candidate) => candidate.tabId === pane.tabId);
    return (
      workspaces.length === 1 && tabs.length === 1 && tabs[0]?.workspaceId === pane.workspaceId
    );
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
  } = makeHerdrLaunchSafety(cli, exactPaneContext);

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
  const quarantinedRunError = (operation: string) =>
    ownershipMismatch(
      operation,
      "The Herdr run is quarantined after an ownership or cleanup uncertainty; no further mutation was attempted.",
    );

  const resolveCallingPane = (
    snapshot: HerdrSnapshot,
  ): Effect.Effect<HerdrPane, SubagentProcessError> => {
    const callingPaneId = cli.callingPaneId;
    if (!callingPaneId)
      return Effect.fail(
        processError(
          "resolve calling pane",
          "herdr_calling_pane_unresolvable",
          "The inherited Herdr calling-pane selector is unavailable.",
        ),
      );
    return cli.currentPane.pipe(
      Effect.flatMap((pane) =>
        pane.paneId === callingPaneId && exactPaneContext(pane, snapshot)
          ? Effect.succeed(matchingPaneIdentity(pane, snapshot)!)
          : Effect.fail(
              processError(
                "resolve calling pane",
                "herdr_calling_pane_unresolvable",
                "The inherited Herdr calling pane did not match one exact live pane/terminal/workspace/tab tuple.",
              ),
            ),
      ),
    );
  };

  const newestOwnedAnchor = (pane: HerdrPane, snapshot: HerdrSnapshot): HerdrPane => {
    for (const run of [...records.values()].reverse()) {
      if (
        run.closed ||
        run.workspaceId !== pane.workspaceId ||
        run.tabId !== pane.tabId ||
        run.quarantined
      )
        continue;
      if (exactPaneContext(run, snapshot) && matchingAgent(run, snapshot))
        return matchingPane(run, snapshot)!;
      quarantineRun(run);
    }
    return pane;
  };

  const inspectOwned = (run: OwnedRun) => {
    if (run.quarantined) return Effect.fail(quarantinedRunError("inspect Herdr agent"));
    return cli.snapshot.pipe(
      Effect.flatMap((snapshot) => {
        const remote = exactPaneContext(run, snapshot) ? matchingAgent(run, snapshot) : undefined;
        if (remote) return Effect.succeed(remote);
        quarantineRun(run);
        return Effect.fail(
          ownershipMismatch(
            "inspect Herdr agent",
            "The session-owned Herdr workspace/tab/pane/terminal/agent/native-session identity changed.",
          ),
        );
      }),
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
        if (!exactPaneContext(run, before) || !matchingAgent(run, before)) {
          quarantineRun(run);
          return yield* ownershipMismatch(
            "close Herdr agent",
            "The exact workspace/tab/pane/terminal/agent/native-session identity changed; no topology was closed.",
          );
        }
        const siblingPanes = before.panes.filter(
          (pane) =>
            pane.paneId !== run.paneId &&
            pane.workspaceId === run.workspaceId &&
            pane.tabId === run.tabId,
        );
        if (siblingPanes.length === 0) {
          quarantineRun(run);
          return yield* ownershipMismatch(
            "close Herdr agent",
            "The owned subagent pane is the last visible pane in its user-owned tab; closure was refused to avoid collapsing the tab or workspace.",
          );
        }
        // Close mutation, confirmation snapshot, and ownership-state publication are one
        // interruption-safe commit. Cancellation is observed only after `closed` or quarantine.
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
              "Herdr acknowledged pane closure, but an owned pane/terminal/agent-name/session selector remains visible.",
            );
          }
          records.delete(run.runId);
          run.closed = true;
          run.launchCleanup.cleanupConfirmed = true;
          run.harness.authorizeCleanup();
        }).pipe(Effect.uninterruptible);
        yield* restoreFocus(before, run.tabId);
      }),
    );

  const rollbackProvisional = (
    evidence: ProvisionalLaunchEvidence,
    harness: HerdrPreparedHarness,
  ): Effect.Effect<void, SubagentProcessError> =>
    Effect.gen(function* () {
      const snapshot = yield* cli.snapshot;
      const pane = exactPaneContext(evidence.pane, snapshot)
        ? matchingPaneIdentity(evidence.pane, snapshot)
        : undefined;
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
      yield* cli.closePane(pane.paneId);
      const after = yield* cli.snapshot;
      if (!provisionalSelectorsAbsent(after, evidence))
        return yield* processError(
          "rollback Herdr pane",
          "herdr_cleanup_unconfirmed",
          "Provisional pane cleanup left an owned pane/terminal/agent-name/session selector visible.",
        );
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
        const callerPane = yield* resolveCallingPane(before);
        const anchor = newestOwnedAnchor(callerPane, before);
        launchCleanup.mutationStarted = true;
        const pane = yield* cli
          .splitPane(anchor.paneId, request.cwd)
          .pipe(Effect.tapError(markDefiniteNonApplication));
        const ownershipInvalidated =
          pane.paneId === anchor.paneId ||
          pane.workspaceId !== callerPane.workspaceId ||
          pane.tabId !== callerPane.tabId ||
          before.panes.some(
            (candidate) =>
              candidate.paneId === pane.paneId || candidate.terminalId === pane.terminalId,
          ) ||
          before.agents.some(
            (agent) => agent.paneId === pane.paneId || agent.terminalId === pane.terminalId,
          );
        const provisional: ProvisionalLaunchEvidence = {
          pane,
          agentName,
          runtime,
          ownershipInvalidated,
        };
        const invalidateProvisional = () => {
          provisional.ownershipInvalidated = true;
        };
        const launch = Effect.gen(function* () {
          if (provisional.ownershipInvalidated) {
            invalidateProvisional();
            return yield* provisionalOwnershipMismatch(
              "launch Herdr agent",
              "Herdr returned topology whose selectors were pre-existing or outside the calling pane's current workspace/tab.",
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
          // Herdr process detection can briefly publish a stale agent classification after shell
          // startup/activation even while process-info proves the exact foreground owner is still
          // the pane shell. Wait without sending input until both bounded evidence sources agree.
          yield* waitForAvailableShell(pane, invalidateProvisional, true);
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
              "Herdr confirmed interactive startup without atomically returning bounded native session ownership evidence; the supported Herdr protocol exposes no launch token for safe delayed adoption.",
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
            if (exactPaneContext(run, snapshot) && matchingAgent(run, snapshot)) return Effect.void;
            invalidateProvisional();
            return Effect.fail(
              provisionalOwnershipMismatch(
                "confirm Herdr agent ownership",
                "The started agent's unique workspace/tab/pane/terminal/name/session ownership changed before commit.",
              ),
            );
          };
          yield* cli.snapshot.pipe(Effect.flatMap(validateStartedOwnership));
          yield* restoreFocus(before, pane.tabId, validateStartedOwnership);
          records.set(run.runId, run);
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

  const launch: HerdrHostContract["launch"] = (runtime, request, supervisor) =>
    Effect.acquireRelease(acquire(runtime, request, supervisor), (hosted) =>
      hosted.close.pipe(Effect.orDie),
    );

  const preflight: HerdrHostContract["preflight"] = (input) =>
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

export class HerdrHost extends Context.Service<HerdrHost, HerdrHostContract>()(
  "pi-subagents/boundary/herdr-host/HerdrHost",
) {
  static readonly layer = Layer.effect(this, makeHerdrHost());
}
