import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { stripTerminalControls } from "pi-cosmic-core";
import { AskUserHostError } from "../questionnaire/errors.ts";
import { formContent, initialFormValues } from "../questionnaire/form-model.ts";
import type { FormField, FormValue } from "../questionnaire/form-protocol.ts";
import type { OwnedFormHost } from "../questionnaire/form-service.ts";
import {
  parseFormInput,
  validateFormOutcome,
  validateFormValue,
} from "../questionnaire/form-validation.ts";
import { displayFormValue, formFieldInstructions } from "../ui/form-render.ts";
import type { AskUserPromptGate } from "./host-prompt.ts";

/** RPC dialogs use the same service ticket. Native select/input receive owned abort signals. */
export const makeOwnedFormDialogsHost =
  (ctx: ExtensionContext, gate?: AskUserPromptGate): OwnedFormHost =>
  (request, owner) =>
    Effect.gen(function* () {
      yield* gate?.awaitOpen ?? Effect.void;
      const acquire = Effect.try({
        try: () => {
          if (gate && !gate.canOpen()) throw new Error("Another prompt is active.");
          return gate?.enter();
        },
        catch: () =>
          new AskUserHostError({ operation: "render", message: "Private form is unavailable." }),
      });
      const select = (title: string, items: readonly string[]) =>
        Effect.tryPromise({
          try: (signal) =>
            ctx.ui.select(stripTerminalControls(title), items.map(stripTerminalControls), {
              signal,
            }),
          catch: () =>
            new AskUserHostError({ operation: "select", message: "Private selection failed." }),
        });
      const input = (title: string) =>
        Effect.tryPromise({
          try: (signal) => ctx.ui.input(stripTerminalControls(title), "", { signal }),
          catch: () =>
            new AskUserHostError({ operation: "input", message: "Private input failed." }),
        });
      const run = Effect.gen(function* () {
        if (request.kind === "url") {
          const action = yield* select(
            `${owner.label}\n${request.message}\nHost: ${new URL(request.url).host}\n${request.url}`,
            ["Accept: open browser", "Decline", "Cancel"],
          );
          return {
            action:
              action === "Accept: open browser"
                ? "accept"
                : action === "Decline"
                  ? "decline"
                  : "cancel",
          } as const;
        }
        const values = new Map(initialFormValues(request));
        const editField = Effect.fn("AskUserHost.editFormField")(function* (field: FormField) {
          for (;;) {
            const menu = [
              "Keep value",
              "Enter value",
              ...(!field.required ? ["Omit field"] : []),
              "Back",
              "Decline",
              "Cancel",
            ];
            const action = yield* select(
              `${formFieldInstructions(field)}\nCurrent: ${displayFormValue(values.get(field.key))}`,
              menu,
            );
            if (!action || action === "Cancel") return "cancel" as const;
            if (action === "Decline") return "decline" as const;
            if (action === "Back") return "back" as const;
            if (action === "Omit field") {
              values.delete(field.key);
              return "back" as const;
            }
            if (action === "Keep value") {
              if (!validateFormValue(field, values.get(field.key))) return "back" as const;
              continue;
            }
            let value: FormValue | undefined;
            if (field.type === "boolean") {
              const answer = yield* select("Choose a value", ["True", "False", "Back"]);
              if (answer === "True" || answer === "False") value = answer === "True";
            } else if (field.type === "enum" || field.type === "multi-enum") {
              const selected = new Set<string>();
              if (field.type === "multi-enum") {
                const current = values.get(field.key);
                if (Array.isArray(current)) current.forEach((item) => selected.add(item));
              }
              for (;;) {
                const choices = field.options.map((option, index) =>
                  stripTerminalControls(
                    `${index + 1}. ${selected.has(option.value) ? "[x] " : ""}${option.title ?? option.value}`,
                  ),
                );
                const answer = yield* select("Choose listed values", [
                  ...choices,
                  ...(field.type === "multi-enum" ? ["Done"] : []),
                  "Back",
                ]);
                if (!answer || answer === "Back") break;
                if (answer === "Done") {
                  value = [...selected];
                  break;
                }
                const option = field.options[choices.indexOf(answer)];
                if (!option) continue;
                if (field.type === "enum") {
                  value = option.value;
                  break;
                }
                if (selected.has(option.value)) selected.delete(option.value);
                else selected.add(option.value);
              }
            } else {
              const answer = yield* input(`${field.title ?? field.key} (${field.type})`);
              if (answer !== undefined && answer.length <= 4096)
                value = parseFormInput(field, answer);
            }
            if (value !== undefined && !validateFormValue(field, value)) {
              values.set(field.key, value);
              return "back" as const;
            }
          }
        });
        for (;;) {
          const edits = request.fields.map((field, index) =>
            stripTerminalControls(
              `${index + 1}. ${field.title ?? field.key}: ${displayFormValue(values.get(field.key))}`,
            ),
          );
          const action = yield* select(
            `${owner.label}\n${request.message}\nReview answers or select a field to edit.`,
            [...edits, "Accept", "Decline", "Cancel"],
          );
          if (!action || action === "Cancel") return { action: "cancel" } as const;
          if (action === "Decline") return { action: "decline" } as const;
          if (action === "Accept") {
            const outcome = validateFormOutcome(request, {
              action: "accept",
              content: formContent(values),
            });
            if (outcome) return outcome;
            continue;
          }
          const field = request.fields[edits.indexOf(action)];
          if (!field) continue;
          const result = yield* editField(field);
          if (result !== "back") return { action: result };
        }
      });
      return yield* Effect.acquireUseRelease(
        acquire,
        () => run,
        (release) =>
          Effect.try({
            try: () => release?.(),
            catch: () =>
              new AskUserHostError({ operation: "close", message: "Private form cleanup failed." }),
          }).pipe(Effect.ignore),
      );
    });
