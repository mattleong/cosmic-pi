import {
  captureCodePreviewPresentationPolicy,
  withCodePreviewShell,
  type CompactAnimationScheduler,
} from "pi-code-previews";
import { defineTool, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { toPiToolOutputSchema } from "pi-cosmic-core";
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
import {
  renderAsyncCall,
  renderAsyncResult,
  renderAsyncMessage,
  renderAsyncContent,
} from "../ui/async-tool-render.ts";
import { argumentsSection } from "../ui/tool-body.ts";
import {
  AskUserAsyncContractSchema,
  AskUserAsyncControlContractSchema,
} from "./contract-schema.ts";
import {
  askUserAsyncContract,
  askUserAsyncControlContract,
  questionnaireToolResult,
} from "./contract.ts";

const START_OUTPUT_SCHEMA = toPiToolOutputSchema(AskUserAsyncContractSchema);
const CONTROL_OUTPUT_SCHEMA = toPiToolOutputSchema(AskUserAsyncControlContractSchema);

/**
 * Register once at factory time: Pi draws historical answers before session_start.
 * Each invocation reads current presentation policy without acquiring session resources.
 */
export function registerAsyncAskUserMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(ASYNC_MESSAGE_TYPE, (message, options, theme) =>
    renderAsyncMessage(
      message,
      options,
      theme,
      captureCodePreviewPresentationPolicy().toolCallCollapsedStyle === "compact",
    ),
  );
}

export function registerAsyncAskUserTools(
  pi: ExtensionAPI,
  start: (input: AskUserAsyncRequest, signal?: AbortSignal) => Promise<AsyncQuestionnaireSnapshot>,
  control: (input: AskUserAsyncControl, signal?: AbortSignal) => Promise<AsyncQuestionnaireResult>,
  scheduleAnimation?: CompactAnimationScheduler,
  shell: typeof withCodePreviewShell = withCodePreviewShell,
): void {
  const presentation = {
    compactSummary: asyncAskUserCompactSummary,
    expandedContent: {
      renderCall: <Args>(args: Args, theme: Theme) => argumentsSection(theme, args),
      renderResult: renderAsyncContent,
    },
    scheduleAnimation,
  };
  pi.registerTool(
    shell(
      defineTool({
        name: "ask_user_async",
        label: "Ask User Async",
        description:
          "Admit a structured questionnaire and return a pending request ID without waiting for answers. TUI only. If another questionnaire is active, return queued immediately; it opens automatically in order after earlier questionnaires and unrelated UI prompts close. Otherwise wait only for its overlay to mount. Same single/multiple choice or required text questions and limits as ask_user. Text mode omits choices and returns a trimmed nonblank answer of at most 4000 code units. All modes support optional notes of at most 2000 code units, plus nonblank independentWork and blockedWork descriptions of at most 500 characters each. Shares a FIFO queue of at most 16 pending questionnaires with blocking and routed child requests. Cannot admit during an unrelated UI prompt; queued requests wait for safe mounting. Answers arrive automatically as a custom steering message unless an await owns delivery. Separately, up to 16 session-local async results are retained. Only delivered, unclaimed terminal results can be evicted; full capacity otherwise rejects admission.",
        promptSnippet: "Ask for decisions while continuing specific independent work",
        promptGuidelines: [
          "Use ask_user_async only when a concrete decision is needed and you can name useful independent work. Otherwise use blocking ask_user.",
          "After ask_user_async returns, do the declared independentWork. Never guess answers or start blockedWork before submission. Use ask_user_async_control await when independent work is exhausted; do not poll status.",
          "Apply ask_user's question batching, text, choice, recommendation, and credential-safety rules to ask_user_async. Cancellation is not approval; do not repeat a cancelled questionnaire immediately.",
          "Async answer messages and control results carry stable delivery IDs. Treat repeated IDs as the same decision. Runtime shutdown, reload, replacement, and tree navigation revoke pending questionnaires.",
          "Native codemode receives structured pi-ask-user/questionnaire version-1 results. Check contract, version, and tool; print the admitted request.requestId immediately. Admission is not an answer. A rejected or cancelled script can leave an admitted questionnaire open: recover through status instead of blindly retrying start.",
        ],
        renderCall(args, theme, context) {
          return renderAsyncCall(args, theme, context);
        },
        renderResult: renderAsyncResult,
        parameters: AskUserAsyncParameters,
        outputSchema: START_OUTPUT_SCHEMA,
        executionMode: "sequential",
        execute(_id, input, signal) {
          return start(input, signal).then((snapshot) =>
            questionnaireToolResult(
              formatAsyncSnapshot(snapshot),
              snapshot,
              askUserAsyncContract(snapshot),
            ),
          );
        },
      }),
      presentation,
    ),
  );
  pi.registerTool(
    shell(
      defineTool({
        name: "ask_user_async_control",
        label: "Questionnaire Control",
        description:
          "Inspect, await, or cancel a session-local async questionnaire. status returns the full request result, or metadata for all retained requests when requestId is omitted. await and cancel require requestId. Await interruption leaves the questionnaire open and restores automatic delivery. Cancel still closes it while another caller owns await delivery. Status is non-consuming. Results carry stable delivery IDs; sent means host call returned, not model acknowledgement. Delivery failures retain the answer for status/await recovery.",
        promptSnippet:
          "Await async answers when independent work is exhausted, or inspect/cancel a questionnaire",
        promptGuidelines: [
          "Native codemode receives structured pi-ask-user/questionnaire version-1 results. Check contract, version, and tool before reading requests. Status without requestId is metadata-only; use await at a dependency barrier, not polling.",
          "Branch on the returned outcome, not the requested action: cancel can return submitted when completion won. sent is not model acknowledgement. Script interruption cancels its wait, not the async questionnaire; do not blindly retry admission or assume cancellation rolled back an answer.",
        ],
        renderCall(args, theme, context) {
          return renderAsyncCall(args, theme, context, true);
        },
        renderResult: renderAsyncResult,
        parameters: AskUserAsyncControlParameters,
        outputSchema: CONTROL_OUTPUT_SCHEMA,
        executionMode: "sequential",
        execute(_id, input, signal) {
          return control(input, signal).then((result) =>
            questionnaireToolResult(
              result.requests.length
                ? result.requests.map(formatAsyncSnapshot).join("\n\n")
                : "No async questionnaires are retained in this runtime.",
              result,
              askUserAsyncControlContract(input, result),
            ),
          );
        },
      }),
      presentation,
    ),
  );
}
