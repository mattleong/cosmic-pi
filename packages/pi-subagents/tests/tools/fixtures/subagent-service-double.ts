import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { SubagentHeldStarts, SubagentServiceContract } from "../../../src/run/service.ts";

export type SubagentServiceDoubleInput = Partial<SubagentServiceContract>;

const unexpected = (method: keyof SubagentServiceContract): Effect.Effect<never> =>
  Effect.die(new Error(`Unexpected SubagentService.${method} call in test fixture.`));

const unexpectedService: SubagentServiceContract = {
  start: () => unexpected("start"),
  startSessionOwned: () => unexpected("startSessionOwned"),
  startScriptSessionOwned: () => unexpected("startScriptSessionOwned"),
  startSessionOwnedFrom: () => unexpected("startSessionOwnedFrom"),
  captureLaunchParent: () => unexpected("captureLaunchParent"),
  visibleList: () => unexpected("visibleList"),
  authorizeTargets: () => unexpected("authorizeTargets"),
  withAwaitTerminalObservations: () => unexpected("withAwaitTerminalObservations"),
  consumeCompletions: (receipts) =>
    receipts.length === 0 ? Effect.void : unexpected("consumeCompletions"),
  withStartFailureHold: () => unexpected("withStartFailureHold"),
  send: () => unexpected("send"),
  interrupt: () => unexpected("interrupt"),
  resume: () => unexpected("resume"),
  rename: () => unexpected("rename"),
  stop: () => unexpected("stop"),
  agentList: () => unexpected("agentList"),
  agentSend: () => unexpected("agentSend"),
  agentRead: () => unexpected("agentRead"),
  workspaceList: () => unexpected("workspaceList"),
  workspaceReview: () => unexpected("workspaceReview"),
  workspacePrepare: () => unexpected("workspacePrepare"),
  workspaceDiscard: () => unexpected("workspaceDiscard"),
  workspaceApply: () => unexpected("workspaceApply"),
  workspaceRevise: () => unexpected("workspaceRevise"),
  sweepOrphanedWorkspaces: Effect.succeed([]),
  inspectWriterWorkspace: unexpected("inspectWriterWorkspace"),
  setWriterWorkspaceMode: () => unexpected("setWriterWorkspaceMode"),
  projection: unexpected("projection"),
  awaitParentDrain: unexpected("awaitParentDrain"),
  deliverPendingCompletions: unexpected("deliverPendingCompletions"),
};

/** The double's own starts, which hold nothing: its failures never reach a notice anyway. */
const heldStarts = (service: SubagentServiceContract): SubagentHeldStarts => ({
  startSessionOwned: (request) => service.startSessionOwned(request),
  startScriptSessionOwned: (request) => service.startScriptSessionOwned(request),
  startSessionOwnedFrom: (callerRunId, request) =>
    service.startSessionOwnedFrom(callerRunId, request),
  workspaceRevise: (...args) => service.workspaceRevise(...args),
});

export function subagentServiceDouble(base: SubagentServiceDoubleInput): SubagentServiceContract {
  const start = base.start ?? unexpectedService.start;
  const startSessionOwned = base.startSessionOwned ?? start;
  const service: SubagentServiceContract = {
    ...unexpectedService,
    start,
    startSessionOwned,
    startScriptSessionOwned: startSessionOwned,
    startSessionOwnedFrom: (_callerRunId, request) => startSessionOwned(request),
    withStartFailureHold: (use) => use(heldStarts(service)),
    ...base,
  };
  return service;
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
