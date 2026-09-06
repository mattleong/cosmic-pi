import * as Effect from "effect/Effect";
import type { SubagentNotFoundError } from "../../../src/run/errors.ts";
import type { SubagentRunObservation, SubagentServiceContract } from "../../../src/run/service.ts";

export type SubagentServiceDoubleInput = Partial<SubagentServiceContract> & {
  /** Optional per-run observation seed used to derive `withStatusObservations`. */
  readonly observeStatus?: (
    id: string,
  ) => Effect.Effect<SubagentRunObservation, SubagentNotFoundError>;
};

const unexpected = (method: keyof SubagentServiceContract): Effect.Effect<never> =>
  Effect.die(new Error(`Unexpected SubagentService.${method} call in test fixture.`));

/** Completes a partial service double with faithful adapters and loud unused-method defects. */
export function subagentServiceDouble(base: SubagentServiceDoubleInput): SubagentServiceContract {
  const start: SubagentServiceContract["start"] = base.start ?? (() => unexpected("start"));
  const startSessionOwned: SubagentServiceContract["startSessionOwned"] =
    base.startSessionOwned ?? start;
  const startSessionOwnedFrom: SubagentServiceContract["startSessionOwnedFrom"] =
    base.startSessionOwnedFrom ?? ((_callerRunId, request) => startSessionOwned(request));
  const list: SubagentServiceContract["list"] = base.list ?? unexpected("list");
  const visibleList: SubagentServiceContract["visibleList"] = base.visibleList ?? (() => list);
  const authorizeTargets: SubagentServiceContract["authorizeTargets"] =
    base.authorizeTargets ?? (() => unexpected("authorizeTargets"));
  const claimRetryContinuation: SubagentServiceContract["claimRetryContinuation"] =
    base.claimRetryContinuation ?? (() => unexpected("claimRetryContinuation"));
  const releaseRetryClaim: SubagentServiceContract["releaseRetryClaim"] =
    base.releaseRetryClaim ?? (() => unexpected("releaseRetryClaim"));
  const exhaustRetryClaim: SubagentServiceContract["exhaustRetryClaim"] =
    base.exhaustRetryClaim ?? (() => unexpected("exhaustRetryClaim"));
  const blockRetryClaim: SubagentServiceContract["blockRetryClaim"] =
    base.blockRetryClaim ?? (() => unexpected("blockRetryClaim"));
  const startRetrySessionOwned: SubagentServiceContract["startRetrySessionOwned"] =
    base.startRetrySessionOwned ?? (() => unexpected("startRetrySessionOwned"));
  const awaitTerminal: SubagentServiceContract["awaitTerminal"] =
    base.awaitTerminal ?? (() => unexpected("awaitTerminal"));
  const status: SubagentServiceContract["status"] = base.status ?? (() => unexpected("status"));
  const observeStatus =
    base.observeStatus ??
    ((id: string) => status(id).pipe(Effect.map((run): SubagentRunObservation => ({ run }))));
  const withStatusObservations: SubagentServiceContract["withStatusObservations"] =
    base.withStatusObservations ??
    ((ids, use) =>
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
      ));
  const withAwaitTerminalObservations: SubagentServiceContract["withAwaitTerminalObservations"] =
    base.withAwaitTerminalObservations ??
    ((ids, until, onUpdate, use) =>
      awaitTerminal(ids, until, onUpdate).pipe(
        Effect.flatMap((runs) => use(runs.map((run): SubagentRunObservation => ({ run })))),
      ));

  return {
    start,
    startSessionOwned,
    startSessionOwnedFrom,
    visibleList,
    authorizeTargets,
    claimRetryContinuation,
    releaseRetryClaim,
    exhaustRetryClaim,
    blockRetryClaim,
    startRetrySessionOwned,
    awaitTerminal,
    withAwaitTerminalObservations,
    list,
    status,
    withStatusObservations,
    consumeCompletions:
      base.consumeCompletions ??
      ((receipts) => (receipts.length === 0 ? Effect.void : unexpected("consumeCompletions"))),
    send: base.send ?? (() => unexpected("send")),
    reply: base.reply ?? (() => unexpected("reply")),
    interrupt: base.interrupt ?? (() => unexpected("interrupt")),
    resume: base.resume ?? (() => unexpected("resume")),
    rename: base.rename ?? (() => unexpected("rename")),
    stop: base.stop ?? (() => unexpected("stop")),
    grantWriteClaims: base.grantWriteClaims ?? (() => unexpected("grantWriteClaims")),
    revokeWriteClaims: base.revokeWriteClaims ?? (() => unexpected("revokeWriteClaims")),
    resumeWriterAdmission:
      base.resumeWriterAdmission ?? (() => unexpected("resumeWriterAdmission")),
    workspaceList: base.workspaceList ?? (() => unexpected("workspaceList")),
    workspaceReview: base.workspaceReview ?? (() => unexpected("workspaceReview")),
    workspacePrepare: base.workspacePrepare ?? (() => unexpected("workspacePrepare")),
    workspaceIntegrate: base.workspaceIntegrate ?? (() => unexpected("workspaceIntegrate")),
    workspaceDiscard: base.workspaceDiscard ?? (() => unexpected("workspaceDiscard")),
    workspaceRevise: base.workspaceRevise ?? (() => unexpected("workspaceRevise")),
    inspectWriterWorkspace: base.inspectWriterWorkspace ?? unexpected("inspectWriterWorkspace"),
    setWriterWorkspaceMode:
      base.setWriterWorkspaceMode ?? (() => unexpected("setWriterWorkspaceMode")),
    projection: base.projection ?? unexpected("projection"),
  };
}
