import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { AgentIdSchema } from "../ui/notice-details.ts";

export const QUESTION_ANSWER_ENTRY_TYPE = "pi-subagents-question-answer";
const decodeAnswer = Schema.decodeUnknownOption(Schema.Struct({ questionId: AgentIdSchema }));

/** Root transcript receipts are UI-only and follow the active branch on replay. */
export function questionAnswerReceipts(pi: ExtensionAPI) {
  const answered = new Set<string>();
  const restore = (ctx: ExtensionContext) => {
    answered.clear();
    const branch = invokeHostCallback(() => ctx.sessionManager.getBranch(), []);
    for (const entry of branch) {
      if (entry.type !== "custom" || entry.customType !== QUESTION_ANSWER_ENTRY_TYPE) continue;
      const answer = decodeAnswer(entry.data);
      if (Option.isSome(answer)) answered.add(answer.value.questionId);
    }
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  return {
    has: (questionId: string) => answered.has(questionId),
    record: (questionId: string): void => {
      if (answered.has(questionId)) return;
      answered.add(questionId);
      // Pi schedules a repaint for a custom entry even without a visible entry renderer.
      pi.appendEntry(QUESTION_ANSWER_ENTRY_TYPE, { questionId });
    },
  };
}
