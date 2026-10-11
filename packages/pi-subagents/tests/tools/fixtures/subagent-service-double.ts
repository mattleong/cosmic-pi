import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { SubagentNotFoundError } from "../../../src/run/errors.ts";
import type { SubagentRunObservation, SubagentServiceContract } from "../../../src/run/service.ts";

export type SubagentServiceDoubleInput = Partial<SubagentServiceContract> & {
  readonly observeStatus?: (
    id: string,
  ) => Effect.Effect<SubagentRunObservation, SubagentNotFoundError>;
};

const unexpected = (method: keyof SubagentServiceContract): Effect.Effect<never> =>
  Effect.die(new Error(`Unexpected SubagentService.${method} call in test fixture.`));

const unexpectedService: SubagentServiceContract = {
  start: () => unexpected("start"),
  startSessionOwned: () => unexpected("startSessionOwned"),
  startScriptSessionOwned: () => unexpected("startScriptSessionOwned"),
  startSessionOwnedFrom: () => unexpected("startSessionOwnedFrom"),
  visibleList: () => unexpected("visibleList"),
  authorizeTargets: () => unexpected("authorizeTargets"),
  claimRetryContinuation: () => unexpected("claimRetryContinuation"),
  releaseRetryClaim: () => unexpected("releaseRetryClaim"),
  exhaustRetryClaim: () => unexpected("exhaustRetryClaim"),
  blockRetryClaim: () => unexpected("blockRetryClaim"),
  startRetrySessionOwned: () => unexpected("startRetrySessionOwned"),
  withAwaitTerminalObservations: () => unexpected("withAwaitTerminalObservations"),
  list: unexpected("list"),
  status: () => unexpected("status"),
  withStatusObservations: () => unexpected("withStatusObservations"),
  consumeCompletions: (receipts) =>
    receipts.length === 0 ? Effect.void : unexpected("consumeCompletions"),
  send: () => unexpected("send"),
  reply: () => unexpected("reply"),
  interrupt: () => unexpected("interrupt"),
  resume: () => unexpected("resume"),
  rename: () => unexpected("rename"),
  stop: () => unexpected("stop"),
  grantWriteClaims: () => unexpected("grantWriteClaims"),
  revokeWriteClaims: () => unexpected("revokeWriteClaims"),
  resumeWriterAdmission: () => unexpected("resumeWriterAdmission"),
  workspaceList: () => unexpected("workspaceList"),
  workspaceReview: () => unexpected("workspaceReview"),
  workspacePrepare: () => unexpected("workspacePrepare"),
  workspaceIntegrate: () => unexpected("workspaceIntegrate"),
  workspaceDiscard: () => unexpected("workspaceDiscard"),
  workspaceDiscardUnchanged: () => unexpected("workspaceDiscardUnchanged"),
  workspaceRevise: () => unexpected("workspaceRevise"),
  inspectWriterWorkspace: unexpected("inspectWriterWorkspace"),
  setWriterWorkspaceMode: () => unexpected("setWriterWorkspaceMode"),
  projection: unexpected("projection"),
  reserveRunId: unexpected("reserveRunId"),
  openOwner: () => unexpected("openOwner"),
  startOwned: () => unexpected("startOwned"),
  awaitOwned: () => unexpected("awaitOwned"),
  closeOwner: () => unexpected("closeOwner"),
  waitForRevision: () => unexpected("waitForRevision"),
  admissionRevision: unexpected("admissionRevision"),
  waitForAdmissionChange: () => unexpected("waitForAdmissionChange"),
  queuedWriterConflict: () => unexpected("queuedWriterConflict"),
  workspaceBindingStatus: () => unexpected("workspaceBindingStatus"),
};

const statusObservations =
  (
    observeStatus: (id: string) => Effect.Effect<SubagentRunObservation, SubagentNotFoundError>,
  ): SubagentServiceContract["withStatusObservations"] =>
  (ids, use) =>
    Effect.forEach(
      ids,
      (id) =>
        observeStatus(id).pipe(
          Effect.match({
            onFailure: () => ({ missingId: id }) as const,
            onSuccess: (observation) => ({ observation }) as const,
          }),
        ),
      { concurrency: 8 },
    ).pipe(
      Effect.flatMap((outcomes) =>
        use({
          observations: outcomes.flatMap((outcome) =>
            "observation" in outcome ? [outcome.observation] : [],
          ),
          missingIds: outcomes.flatMap((outcome) =>
            "missingId" in outcome ? [outcome.missingId] : [],
          ),
        }),
      ),
    );

export function subagentServiceDouble({
  observeStatus,
  ...base
}: SubagentServiceDoubleInput): SubagentServiceContract {
  const start = base.start ?? unexpectedService.start;
  const startSessionOwned = base.startSessionOwned ?? start;
  const list = base.list ?? unexpectedService.list;
  const status = base.status ?? unexpectedService.status;
  return {
    ...unexpectedService,
    start,
    startSessionOwned,
    startScriptSessionOwned: startSessionOwned,
    startSessionOwnedFrom: (_callerRunId, request) => startSessionOwned(request),
    visibleList: () => list,
    list,
    status,
    withStatusObservations: statusObservations(
      observeStatus ??
        ((id) => status(id).pipe(Effect.map((run): SubagentRunObservation => ({ run })))),
    ),
    ...base,
  };
}

export const signalAwaitEntry = (
  service: SubagentServiceContract,
  entered: Deferred.Deferred<void>,
  failures: Array<unknown> = [],
): SubagentServiceContract => ({
  ...service,
  withAwaitTerminalObservations: (ids, until, update, use, coverage) =>
    service
      .withAwaitTerminalObservations(
        ids,
        until,
        (runs, projection) => {
          Deferred.doneUnsafe(entered, Effect.void);
          update?.(runs, projection);
        },
        use,
        coverage,
      )
      .pipe(Effect.tapError((error) => Effect.sync(() => void failures.push(error)))),
});
