import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { invokeBestEffort } from "pi-cosmic-core/host-session";
import { ForeignCallable } from "pi-cosmic-core/schema/foreign-callable";
import { makeSessionCapabilityProtocol } from "pi-cosmic-core/session-capability";
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
import { invalidRequest } from "../run/errors.ts";
import type { SubagentProxyRequest } from "../tools/proxy-protocol.ts";

const relayQueries = makeSessionCapabilityProtocol({ version: 1 });
const encodeOutcome = Schema.encodeSync(Schema.fromJsonString(QuestionnaireOutcomeSchema));
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(QuestionnaireRequestSchema));
const isShownCallback = Schema.is(ForeignCallable<[]>());

const unavailable = () =>
  invalidRequest(
    "questionnaire_unavailable",
    "The parent questionnaire is unavailable or its owning assignment ended.",
  );

/**
 * Asks the root's questionnaire for an authenticated child. `shown` runs at most once, when the
 * root opens the questionnaire on screen, and never once the ask has settled or lost its owner.
 */
export const askParentQuestionnaire = (
  events: ExtensionAPI["events"],
  sessionId: string,
  request: AskUserRequest,
  owner: QuestionnaireOwner,
  shown: () => void = () => undefined,
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
          owned.admitted = true;
          // The root may report late or twice; only the first report of an unsettled ask counts.
          let reported = false;
          const reportShown = () => {
            if (reported || signal.aborted) return;
            reported = true;
            shown();
          };
          return Promise.resolve<unknown>(owned.capability.ask(request, owner, signal, reportShown))
            .finally(() => {
              reported = true;
            })
            .then((outcome) => {
              if (
                signal.aborted ||
                queryQuestionnaireCapability(events, sessionId)?.generation !==
                  owned.capability.generation
              )
                throw new Error("Questionnaire owner expired.");
              const decoded = decodeQuestionnaireOutcome(outcome);
              if (!decoded) throw new Error("Invalid questionnaire result.");
              return {
                content: [{ type: "text" as const, text: encodeOutcome(decoded) }],
                details: decoded,
              };
            });
        },
        catch: unavailable,
      }).pipe(Effect.map((result) => ({ result, generation: owned.capability.generation }))),
    (owned) =>
      owned.admitted
        ? Effect.tryPromise({
            try: () => Promise.resolve<unknown>(owned.capability.cancel(owner)),
            catch: unavailable,
          })
        : Effect.void,
  ).pipe(
    Effect.flatMap(({ result, generation }) =>
      Effect.try({
        try: () => {
          if (queryQuestionnaireCapability(events, sessionId)?.generation !== generation)
            throw new Error("Questionnaire owner expired.");
          return result;
        },
        catch: unavailable,
      }),
    ),
  );

/**
 * Publishes this child's questionnaire relay. `call` proxies the request to the root and runs its
 * `shown` argument when the root reports the questionnaire on screen.
 */
export const publishChildQuestionnaireRelay = (
  events: ExtensionAPI["events"],
  sessionId: string,
  isCurrent: () => boolean,
  call: (
    request: SubagentProxyRequest,
    signal: AbortSignal,
    shown: () => void,
  ) => Promise<AgentToolResult<unknown>>,
): (() => void) => {
  const relay: QuestionnaireRelay = {
    version: 1,
    sessionId,
    ask: (input, signal, shown) => {
      const request = decodeQuestionnaireRequest(input);
      if (!request || signal.aborted || !isCurrent())
        throw new Error("Child questionnaire relay unavailable.");
      // Reported once, and never after the call settles.
      let done = false;
      // The asker's callback: admitted only as callable, and a throw stays with the asker.
      const reportShown = () => {
        if (done || signal.aborted || !isCurrent() || !isShownCallback(shown)) return;
        done = true;
        invokeBestEffort(() => shown());
      };
      return call({ tool: "ask_user", argumentsJson: encodeRequest(request) }, signal, reportShown)
        .finally(() => {
          done = true;
        })
        .then((result) => {
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
