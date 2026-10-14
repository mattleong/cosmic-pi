import * as Effect from "effect/Effect";
import type { RunContext } from "./internal.ts";
import type { launchOperations } from "./launch.ts";
import type { StartSubagentRequest, SubagentRetrySupersession, SubagentRunView } from "./model.ts";
import { runSessionOwned } from "./session-owned.ts";
import type { RunWorkspaceControl } from "./workspace-control.ts";

interface RunSessionStartDependencies extends Pick<
  RunContext,
  "ownerScope" | "withLock" | "requireRecord"
> {
  readonly launch: Pick<ReturnType<typeof launchOperations>, "validate" | "start">;
  readonly workspaces: Pick<RunWorkspaceControl, "withLaunch">;
  readonly redactCompletionReport: (view: SubagentRunView) => SubagentRunView;
  readonly releaseRetryClaim: (id: string, claimToken: string) => Effect.Effect<void>;
}

export function sessionStartOperations(dependencies: RunSessionStartDependencies) {
  const {
    ownerScope,
    withLock,
    requireRecord,
    launch,
    workspaces,
    redactCompletionReport,
    releaseRetryClaim,
  } = dependencies;

  const startWithWorkspace = (request: StartSubagentRequest, scriptedRoot = false) =>
    launch
      .validate(request, scriptedRoot)
      .pipe(
        Effect.andThen(
          workspaces.withLaunch(request, (prepared) => launch.start(prepared, scriptedRoot)),
        ),
      );
  const startWorkspaceSessionOwned = (request: StartSubagentRequest, scriptedRoot = false) =>
    runSessionOwned(ownerScope, Effect.void, () => startWithWorkspace(request, scriptedRoot)).pipe(
      Effect.map((view) => redactCompletionReport(view)),
    );
  const startRetrySessionOwned = (
    request: StartSubagentRequest & { readonly supersedes: SubagentRetrySupersession },
    onOwned?: () => void,
  ) =>
    runSessionOwned(
      ownerScope,
      Effect.void,
      () =>
        startWithWorkspace(request).pipe(
          Effect.ensuring(
            releaseRetryClaim(request.supersedes.runId, request.supersedes.claimToken),
          ),
        ),
      onOwned,
    ).pipe(Effect.map((view) => redactCompletionReport(view)));
  const startSessionOwnedFrom = (callerRunId: string, request: StartSubagentRequest) =>
    withLock(requireRecord(callerRunId).pipe(Effect.map((record) => record.view.cwd))).pipe(
      Effect.flatMap((cwd) =>
        startWorkspaceSessionOwned({ ...request, cwd, parentRunId: callerRunId }),
      ),
    );

  return {
    start: startWithWorkspace,
    startSessionOwned: startWorkspaceSessionOwned,
    startScriptSessionOwned: (request: StartSubagentRequest) =>
      startWorkspaceSessionOwned(request, true),
    startSessionOwnedFrom,
    startRetrySessionOwned,
  };
}
