import { withCodePreviewShell, type CompactAnimationScheduler } from "pi-code-previews";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AskUserAsyncParameters,
  AskUserAsyncControlParameters,
  type AskUserAsyncRequest,
  type AskUserAsyncControl,
} from "../questionnaire/schema.ts";
import type {
  AsyncQuestionnaireSnapshot,
  AsyncQuestionnaireResult,
} from "../questionnaire/async-model.ts";
import { formatAsyncSnapshot } from "../questionnaire/format.ts";
import { asyncAskUserCompactSummary } from "../ui/compact-summary.ts";
import { ASYNC_MESSAGE_TYPE } from "../boundary/host-delivery.ts";
import { renderAsyncCall, renderAsyncResult, renderAsyncMessage } from "../ui/async-tool-render.ts";

export function registerAsyncAskUserTools(
  pi: ExtensionAPI,
  start: (input: AskUserAsyncRequest, signal?: AbortSignal) => Promise<AsyncQuestionnaireSnapshot>,
  control: (input: AskUserAsyncControl, signal?: AbortSignal) => Promise<AsyncQuestionnaireResult>,
  scheduleAnimation?: CompactAnimationScheduler,
): void {
  pi.registerMessageRenderer(ASYNC_MESSAGE_TYPE, renderAsyncMessage);
  pi.registerTool(
    withCodePreviewShell(
      defineTool({
        name: "ask_user_async",
        label: "Ask User Async",
        description:
          "Admit a structured questionnaire and return a pending request ID without waiting for answers. TUI only. If another questionnaire is active, return queued immediately; it opens automatically in order after earlier questionnaires and unrelated UI prompts close. Otherwise wait only for its overlay to mount. Same questions and limits as ask_user, plus nonblank independentWork and blockedWork descriptions of at most 500 characters each. Shares a FIFO queue of at most 16 pending questionnaires with blocking and routed child requests. Cannot admit during an unrelated UI prompt; queued requests wait for safe mounting. Answers arrive automatically as a custom steering message unless an await owns delivery. Separately, up to 16 session-local async results are retained. Only delivered, unclaimed terminal results can be evicted; full capacity otherwise rejects admission.",
        promptSnippet: "Ask for decisions while continuing specific independent work",
        promptGuidelines: [
          "Use ask_user_async only when a concrete decision is needed and you can name useful independent work. Otherwise use blocking ask_user.",
          "After ask_user_async returns, do the declared independentWork. Never guess answers or start blockedWork before submission. Use ask_user_async_control await when independent work is exhausted; do not poll status.",
          "Apply ask_user's question batching, choice, recommendation, and credential-safety rules to ask_user_async. Cancellation is not approval; do not repeat a cancelled questionnaire immediately.",
          "Async answer messages and control results carry stable delivery IDs. Treat repeated IDs as the same decision. Runtime shutdown, reload, replacement, and tree navigation revoke pending questionnaires.",
        ],
        renderCall(args, theme, context) {
          return renderAsyncCall(args, theme, context.expanded);
        },
        renderResult: renderAsyncResult,
        parameters: AskUserAsyncParameters,
        executionMode: "sequential",
        execute(_id, input, signal) {
          return start(input, signal).then((snapshot) => ({
            content: [
              {
                type: "text" as const,
                text: `${formatAsyncSnapshot(snapshot)}\nPresentation: ${snapshot.presentation ?? "open"}. Queued admission is not a mount or an answer.`,
              },
            ],
            details: snapshot,
          }));
        },
      }),
      {
        compactSummary: asyncAskUserCompactSummary,
        scheduleAnimation,
      },
    ),
  );
  pi.registerTool(
    withCodePreviewShell(
      defineTool({
        name: "ask_user_async_control",
        label: "Questionnaire Control",
        description:
          "Inspect, await, or cancel a session-local async questionnaire. status returns the full request result, or metadata for all retained requests when requestId is omitted. await and cancel require requestId. Await interruption leaves the questionnaire open and restores automatic delivery. Cancel still closes it while another caller owns await delivery. Status is non-consuming. Results carry stable delivery IDs; sent means host call returned, not model acknowledgement. Delivery failures retain the answer for status/await recovery.",
        promptSnippet:
          "Await async answers when independent work is exhausted, or inspect/cancel a questionnaire",
        renderCall(args, theme, context) {
          return renderAsyncCall(args, theme, context.expanded, true);
        },
        renderResult: renderAsyncResult,
        parameters: AskUserAsyncControlParameters,
        executionMode: "sequential",
        execute(_id, input, signal) {
          return control(input, signal).then((result) => ({
            content: [
              {
                type: "text" as const,
                text: result.requests.length
                  ? result.requests.map(formatAsyncSnapshot).join("\n\n")
                  : "No async questionnaires are retained in this runtime.",
              },
            ],
            details: result,
          }));
        },
      }),
      {
        compactSummary: asyncAskUserCompactSummary,
        scheduleAnimation,
      },
    ),
  );
}
