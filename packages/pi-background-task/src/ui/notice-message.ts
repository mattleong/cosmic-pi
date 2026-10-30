import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  withCodePreviewMessageShell,
  type CodePreviewMessagePresenter,
  type CompactSummary,
} from "pi-code-previews";
import {
  sanitizeDiagnosticContent,
  sanitizeTerminalLine,
  stripTerminalControls,
} from "pi-cosmic-core/security";
import { TaskNoticeDetailsSchema, type TaskNoticeDetails } from "../task/notice.ts";
import { taskNoticeSummary } from "./compact-summary.ts";

const Envelope = Schema.Struct({
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
  details: Schema.optional(Schema.Unknown),
});
const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const decodeEnvelope = Schema.decodeUnknownOption(Envelope, { onExcessProperty: "ignore" });
const decodeDetails = Schema.decodeUnknownOption(TaskNoticeDetailsSchema, {
  onExcessProperty: "ignore",
});
const isTextPart = Schema.is(TextPart);

const contentText = (content: string | ReadonlyArray<unknown> | undefined): string =>
  Predicate.isString(content)
    ? content
    : Arr.join(
        Arr.map(Arr.filter(content ?? [], isTextPart), (part) => part.text),
        "\n",
      );

const UNKNOWN_NOTICE: CompactSummary = { subject: "finished", outcome: "returned" };

/**
 * What expansion adds below a notice's row: the command, the task's newest output, and its id and
 * directory. A notice stored without display output shows the text the agent read instead.
 */
const expandedLines = (details: TaskNoticeDetails | undefined, stored: string, theme: Theme) => {
  if (details?.tail === undefined) return stored ? ["", stored] : [];
  const { task, tail } = details;
  const output = stripTerminalControls(tail);
  return [
    // The agent's notice redacts the command too.
    theme.fg("dim", sanitizeTerminalLine(sanitizeDiagnosticContent(task.command))),
    ...(output
      ? Arr.map(Str.split(output, "\n"), (line) => theme.fg("toolOutput", line))
      : [theme.fg("muted", "No output")]),
    theme.fg("dim", Arr.join([task.id, sanitizeTerminalLine(task.cwd)], " · ")),
  ];
};

const expansionLabel = (details: TaskNoticeDetails | undefined): string => {
  if (details?.tail === undefined) return "notice";
  return details.tail ? "output" : "details";
};

/**
 * Shows a finished task's notice like a status row: the task, how it ended, and its issues
 * collapsed; its command, newest output, and id expanded. Undecodable details fall back to a
 * neutral row.
 */
export const presentTaskNotice: CodePreviewMessagePresenter = (message, _options, theme) => {
  const envelope = Option.getOrUndefined(decodeEnvelope(message));
  const details = Option.getOrUndefined(decodeDetails(envelope?.details));
  return {
    name: "background_task",
    label: "Background task",
    summary: details ? taskNoticeSummary(details.task) : UNKNOWN_NOTICE,
    expandLabel: expansionLabel(details),
    expanded: () =>
      new Text(
        Arr.join(
          expandedLines(details, stripTerminalControls(contentText(envelope?.content)), theme),
          "\n",
        ),
        0,
        0,
      ),
  };
};

export const renderTaskNotice: MessageRenderer = withCodePreviewMessageShell(presentTaskNotice);
