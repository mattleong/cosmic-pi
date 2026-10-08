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
    const reject = (code: string, message: string) =>
      event
        .respond(false, encodeSubagentProxyPayload({ code, message }) ?? "{}")
        .pipe(Effect.ignore);
    if (
      (event.tool === "ask_user" ? !executeQuestionnaire : !executeProxy) ||
      record.view.runtime !== "pi" ||
      record.stoppedByParent ||
      !isActiveRunState(record.view.state)
    )
      return reject(
        "proxy_caller_disconnected",
        "Nested Pi coordinator access is unavailable for this run.",
      );
    const runKeyPrefix = `${record.view.id}:`;
    const concurrent = [...executions].filter(([candidateKey]) =>
      candidateKey.startsWith(runKeyPrefix),
    ).length;
    if (concurrent >= 16)
      return reject("proxy_capacity", "Nested Pi has too many concurrent coordinator calls.");
    if (FiberMap.hasUnsafe(executions, key))
      return reject(
        "proxy_request_conflict",
        "Nested Pi reused an active coordinator request identity.",
      );
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
        onFailure: (error) => reject(subagentErrorCode(error), error.message),
        onSuccess: (result) =>
          Effect.suspend(() => {
            const payloadJson = encodeSubagentProxyPayload(result);
            return payloadJson
              ? event.respond(true, payloadJson)
              : reject(
                  "proxy_response_oversized",
                  "Nested Pi coordinator response exceeded its bound.",
                );
          }),
      }),
      Effect.ignore,
    );
    // rc.112 forks immediately and removes settled executions. Never replace an active key.
    return FiberMap.run(executions, key, execute, { onlyIfMissing: true }).pipe(Effect.asVoid);
  };
}

export type RunProxyExecution = ReturnType<typeof makeRunProxyExecution>;
