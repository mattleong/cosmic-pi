import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  backgroundTaskCodeModeOutputFits,
  normalizeBackgroundTaskPresentation,
  type BackgroundTaskPresentation,
  BACKGROUND_TASK_CODE_MODE_QUERY,
  BACKGROUND_TASK_CODE_MODE_VERSION,
  BackgroundTaskCodeModeOutputSchema,
  normalizeBackgroundTaskCodeModeCapability,
  type BackgroundTaskCodeModeInput,
  type BackgroundTaskCodeModeOutput,
} from "pi-background-task/code-mode";
import { invokeHostCallback } from "pi-cosmic-core";
import { formatForeignRejection } from "../tools/format.ts";
import { toolError, type ToolError } from "./codemode-runtime.ts";

const decodeOutput = Schema.decodeUnknownEffect(BackgroundTaskCodeModeOutputSchema);

export type BackgroundTaskDispatch = (
  input: BackgroundTaskCodeModeInput,
) => Effect.Effect<BackgroundTaskCodeModeOutput, ToolError>;

/** Queries and invokes only the explicit pi-background-task capability for this Pi session. */
export const makeBackgroundTaskDispatch = (options: {
  readonly events: ExtensionAPI["events"];
  readonly sessionId: string | undefined;
  readonly toolCallId: string;
  /** Current per-call allowance, already capped by the Code Mode host. */
  readonly maxOutputBytes: () => number;
  readonly observationId?: (fiber: number) => number | undefined;
  readonly onDeliveryFailure?: (invocationId: number | undefined) => void;
  readonly observePresentation?: (
    invocationId: number | undefined,
    receipt: BackgroundTaskPresentation,
  ) => void;
  readonly missingPresentation?: () => void;
}): BackgroundTaskDispatch => {
  let nestedCalls = 0;
  return (input) =>
    Effect.flatMap(Effect.fiberId, (fiber) =>
      Effect.suspend(() => {
        const invocationId = invokeHostCallback(() => options.observationId?.(fiber), undefined);
        let accepting = true;
        let observed = false;
        const sessionId = options.sessionId;
        if (sessionId === undefined) {
          return Effect.fail(
            toolError(
              "Nested tool 'session.backgroundTask' is unavailable because this Pi session has no stable id.",
            ),
          );
        }
        const candidates: Array<
          NonNullable<ReturnType<typeof normalizeBackgroundTaskCodeModeCapability>>
        > = [];
        const emitted = invokeHostCallback(() => {
          options.events.emit(BACKGROUND_TASK_CODE_MODE_QUERY, {
            version: BACKGROUND_TASK_CODE_MODE_VERSION,
            sessionId,
            respond: <Candidate>(candidate: Candidate) => {
              const normalized = normalizeBackgroundTaskCodeModeCapability(candidate);
              if (normalized?.sessionId === sessionId) candidates.push(normalized);
            },
          });
          return true;
        }, false);
        if (!emitted || candidates.length === 0) {
          return Effect.fail(
            toolError(
              "Nested tool 'session.backgroundTask' is unavailable. Load and activate pi-background-task for this session.",
            ),
          );
        }
        if (candidates.length !== 1) {
          return Effect.fail(
            toolError(
              "Nested tool 'session.backgroundTask' is unavailable because multiple background-task providers responded.",
            ),
          );
        }
        const capability = candidates[0]!;
        nestedCalls += 1;
        const callId = `${options.toolCallId}/session.backgroundTask/${nestedCalls}`;
        const maxOutputBytes = options.maxOutputBytes();
        return Effect.tryPromise((signal) =>
          capability.execute(callId, input, signal, maxOutputBytes, (value) => {
            if (!accepting) return;
            const receipt = normalizeBackgroundTaskPresentation(value);
            if (observed || receipt === undefined || receipt.summary?.action !== input.action) {
              invokeHostCallback(() => options.missingPresentation?.(), undefined);
              return;
            }
            observed = true;
            invokeHostCallback(
              () => options.observePresentation?.(invocationId, receipt),
              undefined,
            );
          }),
        ).pipe(
          Effect.mapError((error: Cause.UnknownError) =>
            toolError(
              `Nested tool 'session.backgroundTask' failed: ${formatForeignRejection(error.cause)}`,
            ),
          ),
          Effect.flatMap((output) =>
            decodeOutput(output).pipe(
              Effect.mapError(() =>
                toolError(
                  "Nested tool 'session.backgroundTask' returned an unrecognized result shape.",
                ),
              ),
              Effect.flatMap((decoded) =>
                backgroundTaskCodeModeOutputFits(decoded, maxOutputBytes)
                  ? Effect.succeed(decoded)
                  : Effect.fail(
                      toolError(
                        "Nested tool 'session.backgroundTask' returned output beyond the current child-output allowance.",
                      ),
                    ),
              ),
            ),
          ),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              // A presentation receipt precedes companion output projection. Rejection after
              // that receipt is loss of the reply, unlike a received native tool exception.
              if (observed && exit._tag === "Failure")
                invokeHostCallback(() => options.onDeliveryFailure?.(invocationId), undefined);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              accepting = false;
              if (!observed) invokeHostCallback(() => options.missingPresentation?.(), undefined);
            }),
          ),
        );
      }),
    );
};
