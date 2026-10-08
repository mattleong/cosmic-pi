/** Native codemode's success-only contract; persisted display details remain unchanged. */
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { freezeSnapshot } from "pi-cosmic-core";
import { MAX_RETAINED_REQUESTS } from "../questionnaire/async-model.ts";
import { QuestionnaireOutcomeSchema } from "../questionnaire/protocol.ts";
import { MAX_WORK_DESCRIPTION_LENGTH } from "../questionnaire/schema.ts";

export const QUESTIONNAIRE_CONTRACT_ID = "pi-ask-user/questionnaire";
export const QUESTIONNAIRE_CONTRACT_VERSION = 1;
const envelope = {
  contract: Schema.Literal(QUESTIONNAIRE_CONTRACT_ID),
  version: Schema.Literal(QUESTIONNAIRE_CONTRACT_VERSION),
};
const text = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const RequestId = text(100);
const WorkDescription = text(MAX_WORK_DESCRIPTION_LENGTH).check(Schema.isPattern(/\S/));

/** Exact public metadata only; no drafts, prompts, ownership, or host capabilities. */
const AsyncSnapshotSchema = Schema.Struct({
  requestId: RequestId,
  deliveryId: text(120),
  status: Schema.Literals(["pending", "submitted", "cancelled", "failed"]),
  presentation: Schema.optionalKey(
    Schema.Literals(["queued", "opening", "open", "hidden", "settled"]),
  ),
  independentWork: WorkDescription,
  blockedWork: WorkDescription,
  delivery: Schema.Literals(["pending", "sending", "sent", "failed", "waiter", "none"]).annotate({
    description: "sent means the host call returned, not model acknowledgement.",
  }),
  outcome: Schema.optionalKey(QuestionnaireOutcomeSchema),
});

// Reuse both outcome variants without weakening cancelled's empty answers or submitted bounds.
export const AskUserContractSchema = Schema.Union([
  Schema.Struct({
    ...envelope,
    tool: Schema.Literal("ask_user"),
    ...QuestionnaireOutcomeSchema.members[0].fields,
  }),
  Schema.Struct({
    ...envelope,
    tool: Schema.Literal("ask_user"),
    ...QuestionnaireOutcomeSchema.members[1].fields,
  }),
]);
export const AskUserAsyncContractSchema = Schema.Struct({
  ...envelope,
  tool: Schema.Literal("ask_user_async"),
  request: AsyncSnapshotSchema.annotate({
    description: "Admission receipt, not an answer or permission to begin blocked work.",
  }),
});
export const AskUserAsyncControlContractSchema = Schema.Struct({
  ...envelope,
  tool: Schema.Literal("ask_user_async_control"),
  action: Schema.Literals(["status", "await", "cancel"]).annotate({
    description: "Cancellation can return a submitted outcome when completion won the race.",
  }),
  requestId: Schema.optionalKey(RequestId),
  requests: Schema.Array(AsyncSnapshotSchema).check(Schema.isMaxLength(MAX_RETAINED_REQUESTS)),
});
export const QuestionnaireContractSchema = Schema.Union([
  AskUserContractSchema,
  AskUserAsyncContractSchema,
  AskUserAsyncControlContractSchema,
]);
export type QuestionnaireContract = typeof QuestionnaireContractSchema.Type;
export type AskUserContract = typeof AskUserContractSchema.Type;
export type AskUserAsyncContract = typeof AskUserAsyncContractSchema.Type;
export type AskUserAsyncControlContract = typeof AskUserAsyncControlContractSchema.Type;

const encodeContract = Schema.encodeExit(Schema.toCodecJson(QuestionnaireContractSchema), {
  errors: "first",
  onExcessProperty: "error",
});

/** No normalization or redaction: decision strings must survive this boundary losslessly. */
export const encodeQuestionnaireContract = (
  contract: QuestionnaireContract,
): Schema.Json | undefined => {
  try {
    const exit = encodeContract(contract);
    return Exit.isSuccess(exit) ? freezeSnapshot(exit.value) : undefined;
  } catch {
    return undefined;
  }
};
