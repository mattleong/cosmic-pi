import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Schema from "effect/Schema";
import { stripTerminalControls } from "pi-cosmic-core";
import { renderToolHeader, toolStatusLine } from "pi-cosmic-ui/tool";
import { MAX_RETAINED_REQUESTS } from "../questionnaire/async-model.ts";
import {
  answerLine,
  decodeCallTitles,
  fallbackText,
  outcomeProjection,
  projection,
} from "./tool-render-projection.ts";

const Outcome = outcomeProjection({ note: Schema.optional(Schema.String) });
const Snapshot = Schema.Struct({
  requestId: Schema.String,
  deliveryId: Schema.String,
  status: Schema.Literals(["pending", "submitted", "cancelled", "failed"]),
  delivery: Schema.Literals(["pending", "sending", "sent", "failed", "waiter", "none"]),
  outcome: Schema.optional(Outcome),
});

const envelope = projection(
  Schema.Struct({
    details: Schema.optional(Schema.Unknown),
    content: Schema.optional(Schema.Unknown),
  }),
);
const snapshot = projection(Snapshot);
const requests = projection(
  Schema.Struct({
    requests: Schema.Array(Snapshot).check(Schema.isMaxLength(MAX_RETAINED_REQUESTS)),
  }),
);
const notification = projection(
  Schema.Struct({
    requestId: Schema.String,
    deliveryId: Schema.String,
    generation: Schema.String,
    outcome: Outcome,
  }),
);
const control = projection(
  Schema.Struct({
    action: Schema.Literals(["status", "await", "cancel"]),
    requestId: Schema.optional(Schema.String),
  }),
);
const fallback = <Content>(content: Content): string => fallbackText(content, true);

function outcomeLines(outcome: typeof Outcome.Type | undefined, theme: Theme): string[] {
  if (outcome?.outcome !== "submitted") return [];
  return outcome.answers.flatMap((answer) => {
    const lines = [answerLine(answer, theme)];
    if (answer.note) lines.push(theme.fg("muted", `Note: ${stripTerminalControls(answer.note)}`));
    return lines;
  });
}

function summary(
  status: (typeof Snapshot.Type)["status"],
  outcome: typeof Outcome.Type | undefined,
  theme: Theme,
): string[] {
  const label = {
    pending: "Waiting for your answers",
    submitted: "Answers submitted",
    cancelled: "Questionnaire cancelled",
    failed: "Questionnaire failed. No answer was recorded.",
  }[status];
  return [
    toolStatusLine(
      theme,
      status === "submitted" ? "success" : status === "failed" ? "error" : "warning",
      label,
    ),
    ...outcomeLines(status === "submitted" ? outcome : undefined, theme),
  ];
}

export function renderAsyncCall<Input>(
  input: Input,
  theme: Theme,
  expanded: boolean,
  isControl = false,
): Text {
  const call = control(input);
  const questions = decodeCallTitles(input)?.questions;
  const title = isControl
    ? {
        status: "Questionnaire status",
        await: "Waiting for answers",
        cancel: "Cancel questionnaire",
      }[call?.action ?? "status"]
    : "Ask user";
  const subtitle = isControl
    ? expanded && call?.requestId
      ? stripTerminalControls(call.requestId)
      : undefined
    : questions?.map((question) => stripTerminalControls(question.title)).join(", ");
  return new Text(renderToolHeader({ title, subtitle }, theme), 0, 0);
}

export function renderAsyncResult<Input>(
  input: Input,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
): Text {
  if (options.isPartial)
    return new Text(toolStatusLine(theme, "warning", "Waiting for questionnaire update"), 0, 0);
  const result = envelope(input);
  const single = snapshot(result?.details);
  const list = requests(result?.details)?.requests;
  const rows = single ? [single] : list;
  const lines = rows?.flatMap((row) => [
    ...summary(row.status, row.outcome, theme),
    ...(row.delivery === "failed"
      ? [
          toolStatusLine(
            theme,
            "warning",
            "Automatic delivery failed. The agent can still retrieve this answer.",
          ),
        ]
      : []),
  ]);
  if (rows?.length === 0) lines?.push("No questionnaires to show.");
  if (options.expanded && rows) {
    for (const row of rows) {
      lines?.push(
        theme.fg(
          "dim",
          `Request ${stripTerminalControls(row.requestId)} · delivery ${stripTerminalControls(row.deliveryId)} · ${row.status} · delivery status ${row.delivery}`,
        ),
      );
    }
    lines?.push(
      fallback(result?.content),
      theme.fg(
        "dim",
        "Delivery status sent means the host call returned, not that the model acknowledged the answers.",
      ),
    );
  }
  return new Text(lines?.join("\n") ?? fallback(result?.content), 0, 0);
}

export function renderAsyncMessage<Input>(
  input: Input,
  options: { expanded: boolean; outputPad: number },
  theme: Theme,
): Text {
  const message = envelope(input);
  const details = notification(message?.details);
  if (!details) return new Text(fallback(message?.content), options.outputPad, 0);
  const lines = summary(details.outcome.outcome, details.outcome, theme);
  if (options.expanded) {
    lines.push(
      theme.fg(
        "dim",
        `Request ${stripTerminalControls(details.requestId)} · delivery ${stripTerminalControls(details.deliveryId)} · generation ${stripTerminalControls(details.generation)}`,
      ),
      fallback(message?.content),
      theme.fg("dim", "This notification does not confirm model acknowledgement of the answers."),
    );
  }
  return new Text(lines.join("\n"), options.outputPad, 0);
}
