import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import type * as Scope from "effect/Scope";
import type { AskUserRequest } from "pi-ask-user/protocol";
import type { BackendEvent, BackendProxyRequest, BackendProxyResult } from "../backend/model.ts";
import {
  decodeQuestionnaireProxyRequest,
  encodeSubagentProxyPayload,
} from "../tools/proxy-protocol.ts";
import { InvalidSubagentRequestError, subagentErrorCode, type SubagentError } from "./errors.ts";
import type { RunRecord } from "./internal.ts";
import { isActiveRunState } from "./model.ts";

interface RunProxyExecutionDependencies {
  readonly ownerScope: Scope.Scope;
  /** Acquired by the service before its leaf-first shutdown finalizer. */
  readonly executions: FiberMap.FiberMap<string, void, never>;
  readonly executeProxy?: (
    callerRunId: string,
    request: BackendProxyRequest,
  ) => Effect.Effect<BackendProxyResult, SubagentError>;
  readonly executeQuestionnaire?: (
    record: RunRecord,
    requestId: string,
    request: AskUserRequest,
  ) => Effect.Effect<BackendProxyResult, SubagentError>;
}

/** Authenticated dispatch and keyed execution; the service owns map and questionnaire lifetimes. */
export function makeRunProxyExecution(dependencies: RunProxyExecutionDependencies) {
  const { ownerScope, executions, executeProxy, executeQuestionnaire } = dependencies;
  return (
    record: RunRecord,
    event: Extract<BackendEvent, { readonly type: "proxy_request" | "proxy_cancel" }>,
  ): Effect.Effect<void> => {
    const key = `${record.view.id}:${event.requestId}`;
    if (event.type === "proxy_cancel")
      // Cancellation never waits on the interrupted execution's finalizers in the event loop.
      return FiberMap.remove(executions, key).pipe(
        Effect.forkIn(ownerScope, { startImmediately: true }),
        Effect.asVoid,
      );
    if (
      (event.tool === "ask_user" ? !executeQuestionnaire : !executeProxy) ||
      record.view.runtime !== "pi" ||
      record.stoppedByParent ||
      !isActiveRunState(record.view.state)
    )
      return event
        .respond(
          false,
          encodeSubagentProxyPayload({
            code: "proxy_caller_disconnected",
            message: "Nested Pi coordinator access is unavailable for this run.",
          }) ?? "{}",
        )
        .pipe(Effect.ignore);
    const runKeyPrefix = `${record.view.id}:`;
    let concurrent = 0;
    for (const [candidateKey] of executions)
      if (candidateKey.startsWith(runKeyPrefix)) concurrent += 1;
    if (concurrent >= 16)
      return event
        .respond(
          false,
          encodeSubagentProxyPayload({
            code: "proxy_capacity",
            message: "Nested Pi has too many concurrent coordinator calls.",
          }) ?? "{}",
        )
        .pipe(Effect.ignore);
    if (FiberMap.hasUnsafe(executions, key))
      return event
        .respond(
          false,
          encodeSubagentProxyPayload({
            code: "proxy_request_conflict",
            message: "Nested Pi reused an active coordinator request identity.",
          }) ?? "{}",
        )
        .pipe(Effect.ignore);
    const questionnaire =
      event.tool === "ask_user" ? decodeQuestionnaireProxyRequest(event) : undefined;
    const dispatch =
      questionnaire instanceof InvalidSubagentRequestError
        ? Effect.fail(questionnaire)
        : questionnaire && executeQuestionnaire
          ? executeQuestionnaire(record, event.requestId, questionnaire)
          : executeProxy!(record.view.id, event);
    const execute = dispatch.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          event.respond(
            false,
            encodeSubagentProxyPayload({
              code: subagentErrorCode(error),
              message: error.message,
            }) ?? "{}",
          ),
        onSuccess: (result) =>
          Effect.suspend(() => {
            const payloadJson = encodeSubagentProxyPayload(result);
            return payloadJson
              ? event.respond(true, payloadJson)
              : event.respond(
                  false,
                  encodeSubagentProxyPayload({
                    code: "proxy_response_oversized",
                    message: "Nested Pi coordinator response exceeded its bound.",
                  }) ?? "{}",
                );
          }),
      }),
      Effect.ignore,
    );
    // rc.112 forks immediately and removes settled executions. Never replace an active key.
    return FiberMap.run(executions, key, execute, { onlyIfMissing: true }).pipe(Effect.asVoid);
  };
}
