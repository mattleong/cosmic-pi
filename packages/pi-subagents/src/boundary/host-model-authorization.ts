import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { InvalidSubagentRequestError } from "../run/errors.ts";
import { safeTextPrefix } from "../run/state.ts";
import { sanitizeTerminalLine } from "../ui/sanitize.ts";

const MAX_AUTHORIZATION_NAME_CHARS = 80;
const MAX_AUTHORIZATION_SELECTOR_CHARS = 512;
const MAX_AUTHORIZATION_TASK_CHARS = 320;

export interface ExplicitModelOverrideRequest {
  readonly index: number;
  readonly selector: string;
  readonly task: string;
  readonly name?: string | undefined;
}

/** Opaque, single-use evidence created only after the host user confirms one launch batch. */
export interface ExplicitModelAuthorization {
  readonly index: number;
  readonly selector: string;
  readonly task: string;
}

export interface ExplicitModelAuthorizationGrant {
  readonly index: number;
  readonly authorization: ExplicitModelAuthorization;
}

const issuedAuthorizations = new WeakSet<ExplicitModelAuthorization>();

const authorizationError = (message: string) =>
  new InvalidSubagentRequestError({
    code: "explicit_model_not_authorized",
    message,
  });

const issueAuthorization = (request: ExplicitModelOverrideRequest): ExplicitModelAuthorization => {
  const authorization = Object.freeze({
    index: request.index,
    selector: request.selector.trim(),
    task: request.task.trim(),
  });
  issuedAuthorizations.add(authorization);
  return authorization;
};

/** Consume a matching authorization so it cannot authorize a later resolution or launch. */
export const consumeExplicitModelAuthorization = (
  authorization: ExplicitModelAuthorization | undefined,
  index: number,
  selector: string,
  task: string,
): boolean => {
  if (
    !authorization ||
    !issuedAuthorizations.has(authorization) ||
    authorization.index !== index ||
    authorization.selector !== selector.trim() ||
    authorization.task !== task.trim()
  )
    return false;
  issuedAuthorizations.delete(authorization);
  return true;
};

const boundedPromptValue = (value: string, maximumLength: number): string => {
  const sanitized = sanitizeTerminalLine(value);
  if (sanitized.length <= maximumLength) return sanitized;
  const marker = `… [${sanitized.length} chars]`;
  return `${safeTextPrefix(sanitized, Math.max(0, maximumLength - marker.length))}${marker}`;
};

const promptText = (requests: ReadonlyArray<ExplicitModelOverrideRequest>): string => {
  const lines = requests.map((request) => {
    const label = request.name?.trim()
      ? boundedPromptValue(request.name, MAX_AUTHORIZATION_NAME_CHARS)
      : `launch ${request.index + 1}`;
    const selector = boundedPromptValue(request.selector, MAX_AUTHORIZATION_SELECTOR_CHARS);
    const task = boundedPromptValue(request.task, MAX_AUTHORIZATION_TASK_CHARS);
    return `${request.index + 1}. ${label} · ${selector}\n   ${task}`;
  });
  // Every request gets a row. Per-field bounds keep the dialog finite without ever authorizing an
  // item omitted by aggregate truncation.
  return [
    "Approve only if you explicitly requested every model override below. Otherwise choose No; affected launches can be retried without model to use configured profile routing.",
    "",
    ...lines,
  ].join("\n");
};

/**
 * Pi host boundary for explicit model authorization. A confirmation approves only the listed
 * launch batch; returned grants are bound to index, selector, and task and are single-use.
 */
export const authorizeExplicitModelOverrides = (
  requests: ReadonlyArray<ExplicitModelOverrideRequest>,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Effect.Effect<ReadonlyArray<ExplicitModelAuthorizationGrant>, InvalidSubagentRequestError> => {
  if (requests.length === 0) return Effect.succeed([]);
  if (!ctx.hasUI)
    return Effect.fail(
      authorizationError(
        "Explicit subagent model overrides require direct user authorization, but no confirmation UI is available. Retry without model to use configured profile routing.",
      ),
    );

  const title = requests.length === 1 ? "Authorize subagent model?" : "Authorize subagent models?";
  return Effect.tryPromise({
    try: () => ctx.ui.confirm(title, promptText(requests), signal ? { signal } : undefined),
    catch: () =>
      authorizationError(
        "Explicit subagent model overrides could not be confirmed. Retry without model to use configured profile routing.",
      ),
  }).pipe(
    Effect.flatMap((confirmed) =>
      confirmed
        ? Effect.succeed(
            requests.map((request) => ({
              index: request.index,
              authorization: issueAuthorization(request),
            })),
          )
        : Effect.fail(
            authorizationError(
              "The user did not authorize the explicit subagent model override. Retry without model to use configured profile routing.",
            ),
          ),
    ),
  );
};
