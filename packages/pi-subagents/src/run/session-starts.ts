import * as Effect from "effect/Effect";
import { isInactiveRunRecord, type RunContext } from "./internal.ts";
import type { launchOperations } from "./launch.ts";
import type {
  StartSubagentRequest,
  SubagentLaunchParent,
  SubagentParentContext,
  SubagentRetrySupersession,
  SubagentRunView,
} from "./model.ts";
import { invalidRequest } from "./errors.ts";
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
  const captureLaunchParent = (runId: string, nativeContext?: SubagentParentContext) =>
    withLock(
      Effect.gen(function* () {
        const record = yield* requireRecord(runId);
        const view = record.view;
        if (nativeContext) {
          if (isInactiveRunRecord(record))
            return yield* invalidRequest(
              "proxy_caller_disconnected",
              "The parent Pi session is no longer active.",
            );
          if (
            view.runtime !== "pi" ||
            nativeContext.sessionId !== view.sessionId ||
            (nativeContext.sessionFile !== undefined &&
              nativeContext.sessionFile !== view.sessionFile)
          )
            return yield* invalidRequest(
              "parent_context_mismatch",
              "The parent context does not match its registered Pi session.",
            );
          record.parentContext = { ...nativeContext };
        }
        const current = record.view;
        const captured = record.parentContext;
        const sameSession =
          current.runtime === "pi" &&
          captured !== undefined &&
          captured.sessionId === current.sessionId &&
          (captured.sessionFile === undefined || captured.sessionFile === current.sessionFile);
        if (!sameSession) record.parentContext = undefined;
        return {
          cwd: current.cwd,
          // Native selected-model facts are distinct from the last response model in the view.
          // Without an owned snapshot there is no stable native branch to fork.
          parentContext: sameSession
            ? { ...captured }
            : {
                sessionId: current.sessionId ?? current.id,
                model: current.model,
                effort: current.effort,
              },
        } satisfies SubagentLaunchParent;
      }),
    );
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
    captureLaunchParent,
    startRetrySessionOwned,
  };
}
