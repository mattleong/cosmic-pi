/** Pure, explicit projections of service facts; never infer decisions from formatted text. */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type {
  AsyncQuestionnaireResult,
  AsyncQuestionnaireSnapshot,
} from "../questionnaire/async-model.ts";
import type { AskUserOutcome } from "../questionnaire/model.ts";
import type { AskUserAsyncControl } from "../questionnaire/schema.ts";
import {
  QUESTIONNAIRE_CONTRACT_ID,
  QUESTIONNAIRE_CONTRACT_VERSION,
  encodeQuestionnaireContract,
  type AskUserContract,
  type AskUserAsyncContract,
  type AskUserAsyncControlContract,
  type QuestionnaireContract,
} from "./contract-schema.ts";

const envelope = {
  contract: QUESTIONNAIRE_CONTRACT_ID,
  version: QUESTIONNAIRE_CONTRACT_VERSION,
} as const;

/** User-supplied keys, values, labels, text and notes are copied verbatim, never sanitized. */
const projectOutcome = (outcome: AskUserOutcome): AskUserOutcome =>
  outcome.outcome === "cancelled"
    ? { outcome: outcome.outcome, answers: outcome.answers }
    : {
        outcome: outcome.outcome,
        answers: outcome.answers.map((answer) => ({
          key: answer.key,
          ...(answer.note !== undefined && { note: answer.note }),
          ...(answer.kind === "choices"
            ? { kind: answer.kind, values: answer.values, labels: answer.labels }
            : { kind: answer.kind, text: answer.text }),
        })),
      };

const projectSnapshot = (
  snapshot: AsyncQuestionnaireSnapshot,
  includeOutcome = true,
): AsyncQuestionnaireSnapshot => ({
  requestId: snapshot.requestId,
  deliveryId: snapshot.deliveryId,
  status: snapshot.status,
  ...(snapshot.presentation !== undefined && { presentation: snapshot.presentation }),
  independentWork: snapshot.independentWork,
  blockedWork: snapshot.blockedWork,
  delivery: snapshot.delivery,
  ...(includeOutcome &&
    snapshot.outcome !== undefined && { outcome: projectOutcome(snapshot.outcome) }),
});

export const askUserContract = (outcome: AskUserOutcome): AskUserContract => ({
  ...envelope,
  tool: "ask_user",
  ...projectOutcome(outcome),
});
export const askUserAsyncContract = (
  snapshot: AsyncQuestionnaireSnapshot,
): AskUserAsyncContract => ({
  ...envelope,
  tool: "ask_user_async",
  request: projectSnapshot(snapshot),
});
export const askUserAsyncControlContract = (
  input: AskUserAsyncControl,
  result: AsyncQuestionnaireResult,
): AskUserAsyncControlContract => ({
  ...envelope,
  tool: "ask_user_async_control",
  action: input.action,
  ...(input.requestId !== undefined && { requestId: input.requestId }),
  requests: result.requests.map((snapshot) =>
    projectSnapshot(snapshot, input.action !== "status" || input.requestId !== undefined),
  ),
});

/**
 * The service already ran. A producer invariant failure must preserve its original receipt and
 * details, never synthesize cancellation, retry effects, or disclose codec diagnostics.
 */
export const questionnaireToolResult = <Details>(
  text: string,
  details: Details,
  contract: QuestionnaireContract,
): AgentToolResult<Details> => {
  const structuredContent = encodeQuestionnaireContract(contract);
  return structuredContent === undefined
    ? {
        content: [
          {
            type: "text",
            text: `Questionnaire result is unavailable; the action may have taken effect\n${text}`,
          },
        ],
        details,
        isError: true,
      }
    : { content: [{ type: "text", text }], details, structuredContent };
};
