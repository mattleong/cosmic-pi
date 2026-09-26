import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeSessionCapabilityProtocol } from "pi-cosmic-core";
import {
  decodeQuestionnaireOutcome,
  decodeQuestionnaireRequest,
  queryQuestionnaireCapability,
  QUESTIONNAIRE_RELAY_QUERY,
  QuestionnaireRequestSchema,
  QuestionnaireOutcomeSchema,
  type AskUserRequest,
  type QuestionnaireOwner,
  type QuestionnaireRelay,
} from "pi-ask-user/protocol";
import { InvalidSubagentRequestError } from "../run/errors.ts";
import type { SubagentProxyRequest } from "../tools/proxy-protocol.ts";

const relayQueries = makeSessionCapabilityProtocol({ version: 1 });

const unavailable = () =>
  new InvalidSubagentRequestError({
    code: "questionnaire_unavailable",
    message: "The parent questionnaire is unavailable or its owning assignment ended.",
  });

/** Sole structured-questionnaire door. No tool lookup or extension UI RPC forwarding. */
export const askParentQuestionnaire = (
  events: ExtensionAPI["events"],
  sessionId: string,
  request: AskUserRequest,
  owner: QuestionnaireOwner,
) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const capability = queryQuestionnaireCapability(events, sessionId);
        if (!capability) throw new Error("Questionnaire capability unavailable.");
        return { capability, admitted: false };
      },
      catch: unavailable,
    }),
    (owned) =>
      Effect.tryPromise({
        try: (signal) => {
          if (signal.aborted) throw new Error("Questionnaire owner expired.");
          // Install cleanup ownership before entering the interruptible foreign wait.
          // A synchronous admission failure is safe: cancel targets only this exact owner.
          owned.admitted = true;
          return owned.capability.ask(request, owner, signal).then((outcome) => {
            if (
              signal.aborted ||
              queryQuestionnaireCapability(events, sessionId)?.generation !==
                owned.capability.generation
            )
              throw new Error("Questionnaire owner expired.");
            const decoded = decodeQuestionnaireOutcome(outcome);
            if (!decoded) throw new Error("Invalid questionnaire result.");
            return {
              content: [
                {
                  type: "text" as const,
                  text: Schema.encodeSync(Schema.fromJsonString(QuestionnaireOutcomeSchema))(
                    decoded,
                  ),
                },
              ],
              details: decoded,
            };
          });
        },
        catch: unavailable,
      }).pipe(Effect.map((result) => ({ result, generation: owned.capability.generation }))),
    (owned) =>
      owned.admitted
        ? Effect.tryPromise({
            // This narrow release is masked. Abort alone detaches the Promise adapter;
            // join the root's editor/dialog finalizers even if they stall shutdown.
            try: () => owned.capability.cancel(owner),
            catch: unavailable,
          })
        : Effect.void,
  ).pipe(
    Effect.flatMap(({ result, generation }) =>
      Effect.try({
        try: () => {
          // Cleanup acknowledgement can itself span a root session replacement.
          if (queryQuestionnaireCapability(events, sessionId)?.generation !== generation)
            throw new Error("Questionnaire owner expired.");
          return result;
        },
        catch: unavailable,
      }),
    ),
  );

/** Publish a token-checked relay, never a second ask_user tool definition. */
export const publishChildQuestionnaireRelay = (
  events: ExtensionAPI["events"],
  sessionId: string,
  isCurrent: () => boolean,
  call: (request: SubagentProxyRequest, signal: AbortSignal) => Promise<AgentToolResult<unknown>>,
): (() => void) => {
  const relay: QuestionnaireRelay = {
    version: 1,
    sessionId,
    ask: (input, signal) => {
      const request = decodeQuestionnaireRequest(input);
      if (!request || signal.aborted || !isCurrent())
        throw new Error("Child questionnaire relay unavailable.");
      return call(
        {
          tool: "ask_user",
          argumentsJson: Schema.encodeSync(Schema.fromJsonString(QuestionnaireRequestSchema))(
            request,
          ),
        },
        signal,
      ).then((result) => {
        if (signal.aborted || !isCurrent()) throw new Error("Child questionnaire relay expired.");
        const outcome = decodeQuestionnaireOutcome(result.details);
        if (!outcome) throw new Error("Parent questionnaire returned an invalid result.");
        return outcome;
      });
    },
  };
  return events.on(QUESTIONNAIRE_RELAY_QUERY, (input) => {
    const query = relayQueries.normalizeQuery(input);
    if (query !== undefined && isCurrent() && query.sessionId === sessionId) query.respond(relay);
  });
};
