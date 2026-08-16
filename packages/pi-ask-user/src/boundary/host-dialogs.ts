// Pi dialog APIs are Promise-shaped host boundaries.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AskUserHostError } from "../questionnaire/errors.ts";
import type { AskUserAnswer, AskUserOutcome } from "../questionnaire/model.ts";
import { cancelQuestionnaire } from "../questionnaire/reducer.ts";
import {
  MAX_CUSTOM_ANSWER_LENGTH,
  type AskUserQuestion,
  type AskUserRequest,
} from "../tools/schema.ts";
import { safeText } from "../ui/render.ts";
import { captureExternalEditorCommand, editWithExternalEditor } from "./host-external-editor.ts";
import type { AskUserDialogBridge } from "./host-ui.ts";

export interface HostDialogsContract {
  readonly ask: (request: AskUserRequest) => Effect.Effect<AskUserOutcome, AskUserHostError>;
}

const hostError = (operation: string) =>
  new AskUserHostError({ operation, message: `Unable to ${operation} the user questionnaire.` });

async function boundedInput(
  ui: ExtensionUIContext,
  title: string,
  placeholder: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  while (!signal.aborted) {
    const value = await ui.input(title, placeholder, { signal });
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    if (trimmed.length > 0 && trimmed.length <= MAX_CUSTOM_ANSWER_LENGTH) return trimmed;
    ui.notify(
      trimmed.length === 0
        ? "The answer cannot be empty."
        : `Keep the answer under ${MAX_CUSTOM_ANSWER_LENGTH} characters.`,
      "warning",
    );
  }
  return undefined;
}

const previewText = (question: AskUserQuestion): string => {
  const previews = question.choices.flatMap((choice, index) =>
    choice.preview
      ? [
          `\n--- ${index + 1}. ${safeText(choice.label)} preview ---\n${safeText(choice.preview).slice(0, 600)}`,
        ]
      : [],
  );
  return previews.join("\n").slice(0, 1_500);
};

const optionLines = (question: AskUserQuestion): string[] =>
  question.choices.map(
    (choice, index) => `${index + 1}. ${safeText(choice.label)} — ${safeText(choice.description)}`,
  );

async function askRpcQuestion(
  ui: ExtensionUIContext,
  question: AskUserQuestion,
  signal: AbortSignal,
): Promise<AskUserAnswer | undefined> {
  const title = `[${safeText(question.title)}] ${safeText(question.prompt)}${previewText(question)}`;
  if (question.mode === "single") {
    const options = [
      ...optionLines(question),
      `${question.choices.length + 1}. Write a custom answer`,
    ];
    while (!signal.aborted) {
      const selected = await ui.select(title, options, { signal });
      if (selected === undefined) return undefined;
      const index = options.indexOf(selected);
      if (index < 0) return undefined;
      if (index < question.choices.length) {
        const choice = question.choices[index]!;
        return {
          key: question.key,
          kind: "choices",
          values: [choice.value],
          labels: [choice.label],
        };
      }
      const text = await boundedInput(ui, `${title}\n\nWrite your answer:`, "Your answer", signal);
      if (text !== undefined) return { key: question.key, kind: "custom", text };
      if (!signal.aborted)
        ui.notify("Custom answer dismissed; choose an option or cancel the question.", "info");
    }
    return undefined;
  }

  while (!signal.aborted) {
    const value = await boundedInput(
      ui,
      `${title}\n\n${optionLines(question).join("\n")}\n\nEnter choice numbers separated by commas, or write a custom answer.`,
      "1,3",
      signal,
    );
    if (value === undefined) return undefined;
    const tokens = value.split(/[\s,]+/).filter(Boolean);
    const numeric = tokens.every((token) => /^\d+\.?$/.test(token));
    if (numeric) {
      const indices = tokens.map((token) => Number.parseInt(token, 10) - 1);
      if (indices.some((index) => index < 0 || index >= question.choices.length)) {
        ui.notify(`Use choice numbers from 1 to ${question.choices.length}.`, "warning");
        continue;
      }
      const unique = [...new Set(indices)];
      const choices = unique.map((index) => question.choices[index]!);
      return {
        key: question.key,
        kind: "choices",
        values: choices.map((choice) => choice.value),
        labels: choices.map((choice) => choice.label),
      };
    }
    return { key: question.key, kind: "custom", text: value };
  }
  return undefined;
}

async function runRpc(
  ctx: ExtensionContext,
  request: AskUserRequest,
  signal: AbortSignal,
): Promise<AskUserOutcome> {
  const answers: AskUserAnswer[] = [];
  for (const question of request.questions) {
    const answer = await askRpcQuestion(ctx.ui, question, signal);
    if (!answer) return cancelQuestionnaire();
    answers.push(answer);
  }
  return { outcome: "submitted", answers };
}

async function runTui(
  ctx: ExtensionContext,
  bridge: AskUserDialogBridge,
  request: AskUserRequest,
  signal: AbortSignal,
): Promise<AskUserOutcome> {
  const { AskUserDialog } = await import("../ui/dialog.ts");
  const editorCommand = captureExternalEditorCommand(ctx);
  let close: ((outcome: AskUserOutcome) => void) | undefined;
  let bridgeToken: number | undefined;
  let dialog: import("../ui/dialog.ts").AskUserDialog | undefined;
  const abort = () => close?.(cancelQuestionnaire());
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await ctx.ui.custom<AskUserOutcome>(
      (tui, theme, keybindings, done) => {
        close = done;
        dialog = new AskUserDialog({
          tui,
          theme,
          keybindings,
          request,
          done,
          editExternally: (value) => editWithExternalEditor(tui, editorCommand, value, signal),
          onCollapse: () => {
            if (bridgeToken !== undefined) bridge.markCollapsed(bridgeToken);
          },
        });
        bridgeToken = bridge.activate({ resume: () => dialog?.resume() });
        if (signal.aborted) done(cancelQuestionnaire());
        return dialog;
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "bottom-center",
          width: "100%",
          maxHeight: "100%",
          margin: { left: 0, right: 0, bottom: 0 },
        },
        onHandle: (handle) => dialog?.setOverlayHandle(handle),
      },
    );
  } finally {
    signal.removeEventListener("abort", abort);
    bridge.clear(bridgeToken);
  }
}

export class HostDialogs extends Context.Service<HostDialogs, HostDialogsContract>()(
  "pi-ask-user/boundary/host-dialogs/HostDialogs",
) {
  static layer(ctx: ExtensionContext, bridge: AskUserDialogBridge): Layer.Layer<HostDialogs> {
    return Layer.succeed(
      HostDialogs,
      HostDialogs.of({
        ask: (request) =>
          Effect.tryPromise({
            try: (signal) =>
              ctx.mode === "tui"
                ? runTui(ctx, bridge, request, signal)
                : runRpc(ctx, request, signal),
            catch: () => hostError(ctx.mode === "tui" ? "render" : "open"),
          }),
      }),
    );
  }
}
