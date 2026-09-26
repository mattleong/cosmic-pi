import { createHash } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import {
  agentOwnershipEvidence,
  exactPaneContext,
  matchingAgentIdentity,
  sameAgentOwnership,
  sameAgentSession,
  sameStartedAgent,
  type HerdrAgentOwnershipEvidence as AgentOwnershipEvidence,
} from "../backend/herdr-ownership.ts";
import type { BackendLaunchRequest } from "../backend/model.ts";
import {
  invalidRequest as readinessError,
  isCleanupUnconfirmed,
  isOutcomeUncertain,
  processError,
  type InvalidSubagentRequestError,
  type SubagentProcessError,
} from "../run/errors.ts";
import type { SubagentRuntime } from "../domain/routing.ts";
import { HerdrCli, type HerdrAgent, type HerdrPane, type HerdrSnapshot } from "./herdr-cli.ts";
import { defectCause, HerdrHarness, type HerdrPreparedHarness } from "./herdr-harness.ts";
import { makeHerdrLaunchSafety } from "./herdr-launch-safety.ts";
import type { SupervisorConnectionMetadata } from "./supervisor-channel.ts";

const MAX_LABEL_CHARS = 80;
const MAX_AGENT_NAME_CHARS = 32;
const AGENT_NAME_DIGEST_CHARS = 8;

export interface HerdrHostedAgent {
  readonly agentName: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
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

type LaunchCleanupGuard = { quarantined: boolean };

interface ProvisionalLaunchEvidence {
  readonly pane: HerdrPane;
  readonly agentName: string;
  ownershipInvalidated: boolean;
  startedIdentity?: AgentOwnershipEvidence | undefined;
  agentStartUncertain?: boolean | undefined;
}

interface OwnedRun {
  readonly runId: string;
  readonly agentName: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly identity: AgentOwnershipEvidence;
  readonly launchCleanup: LaunchCleanupGuard;
  readonly harness: HerdrPreparedHarness;
  closed: boolean;
  quarantined: boolean;
}

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

const matchingAgent = (run: OwnedRun, snapshot: HerdrSnapshot): HerdrAgent | undefined =>
  matchingAgentIdentity(run.identity, run.agentName, snapshot);
/** Agents that occupy a provisional pane's selectors, including the name once start may apply. */
const provisionalOccupant = (evidence: ProvisionalLaunchEvidence) => {
  const agentMayHaveApplied =
    evidence.startedIdentity !== undefined || evidence.agentStartUncertain === true;
  return (agent: HerdrAgent): boolean =>
    agent.paneId === evidence.pane.paneId ||
    agent.terminalId === evidence.pane.terminalId ||
    (agentMayHaveApplied && agent.name === evidence.agentName) ||
    (evidence.startedIdentity !== undefined &&
      sameAgentSession(evidence.startedIdentity.agentSession, agent.agentSession));
};

const makeHerdrHost = Effect.fn("HerdrHost.make")(function* () {
  const cli = yield* HerdrCli;
  const harnesses = yield* HerdrHarness;
  const lock = yield* Semaphore.make(1);
  const records = new Map<string, OwnedRun>();
  let closed = false;
  const withLock = lock.withPermits(1);

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
  } = makeHerdrLaunchSafety(cli);

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
  ): boolean =>
    !snapshot.panes.some(
      (pane) =>
        pane.paneId === evidence.pane.paneId || pane.terminalId === evidence.pane.terminalId,
    ) && !snapshot.agents.some(provisionalOccupant(evidence));

  const quarantineRun = (run: OwnedRun): void => void (run.quarantined = true);
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
      Effect.flatMap((pane) => {
        const exact = pane.paneId === callingPaneId ? exactPaneContext(pane, snapshot) : undefined;
        return exact
          ? Effect.succeed(exact)
          : Effect.fail(
              processError(
                "resolve calling pane",
                "herdr_calling_pane_unresolvable",
                "The inherited Herdr calling pane did not match one exact live pane/terminal/workspace/tab tuple.",
              ),
            );
      }),
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
      const owned = exactPaneContext(run, snapshot);
      if (owned && matchingAgent(run, snapshot)) return owned;
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
        yield* Effect.gen(function* () {
          const quarantineOnCause = <Value>(
            effect: Effect.Effect<Value, SubagentProcessError>,
          ): Effect.Effect<Value, SubagentProcessError> =>
            effect.pipe(
              Effect.catchCause((cause) => {
                quarantineRun(run);
                return Effect.failCause(cause);
              }),
            );
          yield* quarantineOnCause(cli.closePane(run.paneId));
          const after = yield* quarantineOnCause(cli.snapshot);
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
          run.launchCleanup.quarantined = false;
          run.harness.authorizeCleanup();
        }).pipe(Effect.uninterruptible);
      }),
    );

  const rollbackProvisional = (
    evidence: ProvisionalLaunchEvidence,
    confirmCleanup: () => void,
  ): Effect.Effect<void, SubagentProcessError> =>
    Effect.gen(function* () {
      const snapshot = yield* cli.snapshot;
      const pane = exactPaneContext(evidence.pane, snapshot);
      const occupants = snapshot.agents.filter(provisionalOccupant(evidence));
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
      confirmCleanup();
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
        if (harness.secretCommand === "") {
          harness.authorizeCleanup();
          return yield* processError(
            "validate Herdr harness",
            "herdr_secret_attestation_invalid",
            "A private Herdr secret bootstrap command must be non-empty when present.",
          );
        }
        const before = yield* cli.snapshot;
        const launchCleanup: LaunchCleanupGuard = { quarantined: false };
        let committed: OwnedRun | undefined;
        const confirmCleanup = () => {
          launchCleanup.quarantined = false;
          if (committed) records.delete(committed.runId);
          if (committed) committed.closed = true;
          harness.authorizeCleanup();
        };
        yield* Effect.addFinalizer(() =>
          launchCleanup.quarantined
            ? Effect.die(
                processError(
                  "finalize Herdr launch",
                  "herdr_launch_cleanup_unconfirmed",
                  "Herdr launch topology or process cleanup remains uncertain.",
                ),
              )
            : Effect.void,
        );
        const callerPane = yield* resolveCallingPane(before);
        const anchor = newestOwnedAnchor(callerPane, before);
        harness.withholdCleanup();
        launchCleanup.quarantined = true;
        const pane = yield* cli.splitPane(anchor.paneId, request.cwd).pipe(
          Effect.catchCause((cause) => {
            if (
              cause.reasons.every(
                (reason) =>
                  Cause.isFailReason(reason) &&
                  !isOutcomeUncertain(reason.error) &&
                  !isCleanupUnconfirmed(reason.error),
              )
            )
              confirmCleanup();
            return Effect.failCause(cause);
          }),
        );
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
        const provisional: ProvisionalLaunchEvidence = { pane, agentName, ownershipInvalidated };
        const invalidateProvisional = () => void (provisional.ownershipInvalidated = true);
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
          yield* waitForAvailableShell(pane, invalidateProvisional);
          yield* activatePaneInput(pane, harness, invalidateProvisional);
          yield* waitForAvailableShell(pane, invalidateProvisional);
          yield* requireAvailableProvisionalPane(
            pane,
            "prepare pane environment",
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
          yield* harness.startupAttestation.environmentReadyReceipt.observe;
          yield* inspectProvisionalPane(pane, "confirm pane environment", invalidateProvisional);
          yield* waitForAvailableShell(pane, invalidateProvisional);
          yield* confirmShellInput(pane, harness, "environment", invalidateProvisional);
          if (harness.secretCommand) {
            yield* waitForAvailableShell(pane, invalidateProvisional);
            yield* requireAvailableProvisionalPane(
              pane,
              "load pane secrets",
              invalidateProvisional,
            );
            yield* cli.runPaneCommand(pane.paneId, harness.secretCommand, "load pane secrets");
            yield* harness.startupAttestation.secretReadyReceipt.observe;
            yield* inspectProvisionalPane(pane, "confirm pane secrets", invalidateProvisional);
            yield* waitForAvailableShell(pane, invalidateProvisional);
            yield* confirmShellInput(pane, harness, "secrets", invalidateProvisional);
          }
          yield* waitForAvailableShell(pane, invalidateProvisional);
          yield* requireAvailableProvisionalPane(
            pane,
            "start agent",
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
            agentName,
            workspaceId: pane.workspaceId,
            tabId: pane.tabId,
            paneId: pane.paneId,
            terminalId: pane.terminalId,
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
          committed = run;
          records.set(run.runId, run);
          const hosted: HerdrHostedAgent = {
            agentName,
            workspaceId: run.workspaceId,
            tabId: run.tabId,
            paneId: run.paneId,
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
        return yield* Effect.uninterruptibleMask((restore) =>
          restore(launch).pipe(
            Effect.catchCause((original) => {
              const originalFailure = original.reasons.find(Cause.isFailReason)?.error;
              const cleanupUnconfirmed = () =>
                processError(
                  "rollback Herdr launch",
                  "herdr_cleanup_unconfirmed",
                  `${originalFailure ? `${originalFailure.message} ` : ""}Provisional Herdr topology cleanup was refused or unconfirmed.`,
                );
              if (provisional.ownershipInvalidated)
                return Effect.failCause(
                  Cause.fromReasons([
                    ...Cause.fail(cleanupUnconfirmed()).reasons,
                    ...original.reasons,
                  ]),
                );
              if (
                original.reasons.some(
                  (reason) =>
                    Cause.isFailReason(reason) &&
                    reason.error.operation === "start agent" &&
                    (isOutcomeUncertain(reason.error) || isCleanupUnconfirmed(reason.error)),
                )
              )
                provisional.agentStartUncertain = true;
              return rollbackProvisional(provisional, confirmCleanup).pipe(
                Effect.uninterruptible,
                Effect.catchCause((cleanup) =>
                  Effect.failCause(
                    Cause.fromReasons([
                      ...Cause.fail(cleanupUnconfirmed()).reasons,
                      ...cleanup.reasons,
                      ...original.reasons,
                    ]),
                  ),
                ),
                Effect.andThen(Effect.failCause(original)),
              );
            }),
          ),
        );
      }),
    );

  const launch: HerdrHostContract["launch"] = (runtime, request, supervisor) =>
    Effect.acquireRelease(
      acquire(runtime, request, supervisor),
      (hosted) =>
        hosted.close.pipe(Effect.catchCause((cause) => Effect.failCause(defectCause(cause)))),
      { interruptible: true },
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
      for (const run of [...records.values()].reverse()) yield* closeOwned(run);
    }).pipe(Effect.catchCause((cause) => Effect.failCause(defectCause(cause)))),
  );

  return HerdrHost.of({ preflight, launch });
});

export class HerdrHost extends Context.Service<HerdrHost, HerdrHostContract>()(
  "pi-subagents/boundary/herdr-host/HerdrHost",
) {
  static readonly layer = Layer.effect(this, makeHerdrHost());
}
