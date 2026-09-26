import {
  BACKGROUND_TASK_PRESENTATION_VERSION,
  projectBackgroundTaskPresentation,
  observeBackgroundTaskPresentation,
  type BackgroundTaskPresentationObserver,
} from "../code-mode/presentation.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { invokeHostCallback, PiSessionRuntimeError } from "pi-cosmic-core";
import {
  BACKGROUND_TASK_CODE_MODE_QUERY,
  BACKGROUND_TASK_CODE_MODE_VERSION,
  BackgroundTaskCodeModeInputSchema,
  normalizeBackgroundTaskCodeModeQuery,
  type BackgroundTaskCodeModeCapability,
  type BackgroundTaskCodeModeInput,
} from "../code-mode/protocol.ts";
import {
  backgroundTaskCodeModeStartOutputFits,
  projectBackgroundTaskCodeModeOutput,
} from "../code-mode/output.ts";
import { InvalidBackgroundCommandError } from "../task/errors.ts";
import { executeBackgroundTaskCommand } from "../tools/command.ts";
import type { BackgroundTaskToolRunner } from "../tools/background-task.ts";
import type { BackgroundTaskToolInput } from "../tools/schema.ts";

const decodeInput = Schema.decodeUnknownEffect(BackgroundTaskCodeModeInputSchema);

export const backgroundTaskCodeModeSessionId = (ctx: ExtensionContext): string | undefined =>
  invokeHostCallback(() => {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    return Predicate.isString(sessionId) && sessionId.length > 0 ? sessionId : undefined;
  }, undefined);

export interface BackgroundTaskCodeModeActivation {
  readonly sessionId: string | undefined;
  readonly tokenCurrent: () => boolean;
  readonly toolActive: () => boolean;
  readonly sessionCwd: string;
  readonly run: BackgroundTaskToolRunner["run"];
}

export interface BackgroundTaskCodeModeHost {
  readonly activate: (activation: BackgroundTaskCodeModeActivation) => void;
  readonly deactivate: () => void;
  readonly dispose: () => void;
}

/**
 * Installs the synchronous query listener. The returned host publishes only one current,
 * session-bound Promise capability and never exposes the service or runtime itself.
 */
export const makeBackgroundTaskCodeModeHost = (
  events: ExtensionAPI["events"],
): BackgroundTaskCodeModeHost => {
  let current:
    | {
        readonly activation: BackgroundTaskCodeModeActivation;
        readonly capability: BackgroundTaskCodeModeCapability;
      }
    | undefined;

  const deactivate = (): void => {
    current = undefined;
  };

  const unsubscribe = events.on(BACKGROUND_TASK_CODE_MODE_QUERY, (value) => {
    const query = normalizeBackgroundTaskCodeModeQuery(value);
    const selected = current;
    if (
      !query ||
      !selected ||
      query.sessionId !== selected.capability.sessionId ||
      !invokeHostCallback(selected.activation.tokenCurrent, false) ||
      !invokeHostCallback(selected.activation.toolActive, false)
    )
      return;
    invokeHostCallback(() => query.respond(selected.capability), undefined);
  });

  return {
    activate: (activation) => {
      deactivate();
      const sessionId = activation.sessionId;
      if (sessionId === undefined) return;
      const capability: BackgroundTaskCodeModeCapability = Object.freeze({
        version: BACKGROUND_TASK_CODE_MODE_VERSION,
        presentationVersion: BACKGROUND_TASK_PRESENTATION_VERSION,
        sessionId,
        execute: (
          _callId: string,
          input: BackgroundTaskCodeModeInput,
          signal: AbortSignal,
          maxOutputBytes: number,
          observePresentation?: BackgroundTaskPresentationObserver,
        ) => {
          if (
            current?.capability !== capability ||
            !invokeHostCallback(activation.tokenCurrent, false) ||
            !invokeHostCallback(activation.toolActive, false)
          ) {
            return Promise.reject(
              new PiSessionRuntimeError({
                operation: "background-task-code-mode",
                message: "Background Tasks is not active for this session.",
              }),
            );
          }
          return activation.run(
            decodeInput(input).pipe(
              Effect.flatMap((decoded) =>
                executeBackgroundTaskCommand(
                  decoded satisfies BackgroundTaskToolInput,
                  activation.sessionCwd,
                  {
                    maxTextBytes: maxOutputBytes,
                    startOutputFits: (request, maxTextBytes) =>
                      backgroundTaskCodeModeStartOutputFits(request, maxTextBytes, maxOutputBytes),
                  },
                ),
              ),
              Effect.flatMap((result) => {
                observeBackgroundTaskPresentation(
                  observePresentation,
                  projectBackgroundTaskPresentation(input, result),
                );
                const projection = projectBackgroundTaskCodeModeOutput(result, maxOutputBytes);
                return projection._tag === "Accepted"
                  ? Effect.succeed(projection.output)
                  : Effect.fail(
                      new InvalidBackgroundCommandError({
                        message:
                          "Background task result exceeds the current Code Mode child-output allowance. " +
                          "Use a narrower action or filter and retry.",
                      }),
                    );
              }),
            ),
            signal,
          );
        },
      });
      current = Object.freeze({ activation, capability });
    },
    deactivate,
    dispose: () => {
      deactivate();
      invokeHostCallback(unsubscribe, undefined);
    },
  };
};
