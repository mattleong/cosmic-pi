import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { invokeBestEffort, invokeHostCallback } from "pi-cosmic-core/host-session";
import { ForeignCallable } from "pi-cosmic-core/schema/foreign-callable";
import { makeSessionCapabilityProtocol } from "pi-cosmic-core/session-capability";
import {
  decodeQuestionnaireOutcome,
  decodeQuestionnaireRequest,
  queryQuestionnaireCapability,
  QUESTIONNAIRE_ASKERS_QUERY,
  QUESTIONNAIRE_RELAY_QUERY,
  QuestionnaireRequestSchema,
  QuestionnaireOutcomeSchema,
  type AskUserOutcome,
  type AskUserRequest,
  type QuestionnaireAskers,
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
 * Asks a session's questionnaire on an owner's behalf: the root's for an authenticated child, or
 * a Rex-hosted child's own for its root. `shown` runs at most once, when the questionnaire opens
 * on screen, and never once the ask has settled or lost its owner.
 */
export const askSessionQuestionnaire = (
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

const encodeQuestions = Schema.encodeSync(QuestionnaireRequestSchema);

interface QuestionnaireAskerRun {
  readonly id: string;
  readonly name: string;
  readonly state: string;
}

/**
 * The run an `askedBy` names: by its ID, or by a name only one run carries. Among namesakes, the
 * one waiting on its parent is the one whose question the parent is passing on.
 */
const namedRun = (
  runs: ReadonlyArray<QuestionnaireAskerRun>,
  askedBy: string,
): QuestionnaireAskerRun | undefined => {
  const byId = Arr.findFirst(runs, (run) => run.id === askedBy);
  if (Option.isSome(byId)) return byId.value;
  const named = Arr.filter(runs, (run) => run.name === askedBy);
  const waiting = Arr.filter(named, (run) => run.state === "waiting_for_parent");
  const [only, ...others] = waiting.length > 0 ? waiting : named;
  return others.length === 0 ? only : undefined;
};

interface QuestionnaireAskersHost {
  /** The root session these runs belong to, while it has one. */
  readonly sessionId: () => string | undefined;
  readonly runs: () => ReadonlyArray<QuestionnaireAskerRun>;
  /** Shows a questionnaire in a run's own pane; `undefined` when the user can't answer it there. */
  readonly present: (
    runId: string,
    request: Schema.Json,
    shown: () => void,
    signal: AbortSignal,
  ) => Promise<Schema.Json | undefined>;
}

/**
 * Tells the root's questionnaire who it is asked for. The parent decides that a subagent's
 * question is the user's to answer and names the subagent; this names the run for the dialog and
 * shows the questions in that run's own pane when the user has it open.
 */
export const publishQuestionnaireAskers = (
  events: ExtensionAPI["events"],
  host: QuestionnaireAskersHost,
): (() => void) =>
  events.on(QUESTIONNAIRE_ASKERS_QUERY, (input) => {
    const query = relayQueries.normalizeQuery(input);
    const sessionId = invokeHostCallback(host.sessionId, undefined);
    if (query === undefined || sessionId === undefined || query.sessionId !== sessionId) return;
    const askers: QuestionnaireAskers = {
      version: 1,
      sessionId,
      find: (askedBy) => {
        const run = namedRun(host.runs(), askedBy);
        return (
          run && {
            name: run.name,
            present: (asked, signal, shown): Promise<AskUserOutcome | undefined> => {
              const request = decodeQuestionnaireRequest(asked);
              if (!request || signal.aborted) return Promise.resolve(undefined);
              // In the run's own pane the questions need no name above them.
              const reportShown = (): void => {
                if (isShownCallback(shown)) invokeBestEffort(() => shown());
              };
              return host
                .present(
                  run.id,
                  encodeQuestions({ questions: request.questions }),
                  reportShown,
                  signal,
                )
                .then(decodeQuestionnaireOutcome);
            },
          }
        );
      },
    };
    query.respond(askers);
  });
