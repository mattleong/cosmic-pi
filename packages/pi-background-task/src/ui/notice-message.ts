import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  expandedBody,
  expandedDetails,
  expandedFields,
  expandedText,
  withCodePreviewMessageShell,
  type CodePreviewMessagePresenter,
  type CompactSummary,
} from "pi-code-previews";
import { contentText } from "pi-cosmic-core/message-text";
import {
  sanitizeDiagnosticContent,
  sanitizeTerminalLine,
  stripTerminalControls,
} from "pi-cosmic-core/security";
import { TaskNoticeDetailsSchema, type TaskNoticeDetails } from "../task/notice.ts";
import { taskExpandLabel, taskNoticeSummary } from "./compact-summary.ts";
import { taskOutputLine } from "./output-lines.ts";
import { displayDirectory } from "./result-facts.ts";
import { subjectAwareComponent } from "./subject-aware.ts";
import { taskDisplayName } from "./task-state.ts";

const Envelope = Schema.Struct({
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
  details: Schema.optional(Schema.Unknown),
});

const decodeEnvelope = Schema.decodeUnknownOption(Envelope, { onExcessProperty: "ignore" });
const decodeDetails = Schema.decodeUnknownOption(TaskNoticeDetailsSchema, {
  onExcessProperty: "ignore",
});

// Without readable details nothing says how the task ended; expansion shows the stored text.
const UNKNOWN_NOTICE: CompactSummary = { subject: "task notice", outcome: "returned" };

/**
 * What expansion adds below a notice's row, laid out like the start row's: the command as a
 * labeled field, the task's newest output, and its id and directory as details. A notice stored
 * without display output shows the text the agent read instead.
 */
const expandedNotice = (
  details: TaskNoticeDetails | undefined,
  stored: string,
  theme: Theme,
  headingState: WeakKey,
): Component => {
  if (details?.tail === undefined)
    return expandedText(theme, undefined, stored ? Str.split(stored, "\n") : []);
  const { task, tail } = details;
  const output = stripTerminalControls(tail);
  // The agent's notice redacts the command too.
  const command = sanitizeTerminalLine(sanitizeDiagnosticContent(task.command));
  const commandIsSubject = command === taskDisplayName(task);
  const body = (subjectShown: boolean): Component =>
    expandedBody(
      expandedFields(theme, [
        // Only a heading that drew this exact command whole already shows it.
        ...(subjectShown && commandIsSubject ? [] : [{ label: "Command", lines: [command] }]),
        ...(output ? [] : [{ label: "Output", lines: ["none"] }]),
      ]),
      expandedText(theme, "Output", output ? Arr.map(Str.split(output, "\n"), taskOutputLine) : []),
      expandedDetails(theme, [Arr.join([task.id, displayDirectory(task.cwd)], " · ")]),
    );
  return subjectAwareComponent(headingState, body);
};

/** The task's output, else its command where the heading names the task, else its details. */
const expansionLabel = (details: TaskNoticeDetails | undefined): string => {
  if (details?.tail === undefined) return "notice";
  return details.tail ? "output" : taskExpandLabel(details.task);
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
    expanded: (headingState) =>
      expandedNotice(
        details,
        stripTerminalControls(contentText(envelope?.content)),
        theme,
        headingState,
      ),
  };
};

export const renderTaskNotice: MessageRenderer = withCodePreviewMessageShell(presentTaskNotice);
