import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import * as Match from "effect/Match";
import { countLabel } from "pi-cosmic-core/display";
import { sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core/security";
import { clipToWidth, managerActivityGlyph, managerActivityColor } from "pi-cosmic-ui/manager";
import { composeToolComponent } from "pi-cosmic-ui/tool";
import type { CodePreviewMessagePresenter, CompactSummary } from "pi-code-previews";
import {
  agentTextBlockLines,
  agentTextLines,
  bodyIndent,
  detailsSectionLines,
  indentedLines,
} from "./agent-text.ts";
import { decodeMessageEnvelope, messageContentText } from "./message-envelope.ts";
import { NoticeDetailsSchema, type NoticeDetails, type NoticeRun } from "./notice-details.ts";

const decodeDetails = Schema.decodeUnknownOption(NoticeDetailsSchema, {
  onExcessProperty: "ignore",
});

// Notices saved before display copies: which notice it was, from its message type.
const UNTYPED_NOTICES = new Map<string, NoticeHeading>([
  [
    "pi-subagents-proxy-notification",
    {
      name: "agent_update",
      label: "Agent update",
      summary: { subject: "a nested subagent", outcome: "returned" },
    },
  ],
  [
    "pi-subagents-peer-notice",
    {
      name: "agent_peers",
      label: "Agent peers",
      summary: { subject: "shared directory", outcome: "returned" },
    },
  ],
]);

const STOP_CAUSES = { reload: "on reload", session: "on leaving the session" };

interface NoticeHeading {
  readonly name: string;
  readonly label: string;
  readonly summary: CompactSummary;
}

type CompletedDetails = Extract<NoticeDetails, { readonly kind: "completed" }>;
type StoppedDetails = Extract<NoticeDetails, { readonly kind: "stopped" }>;
type PeerDetails = Extract<NoticeDetails, { readonly kind: "peers" }>;

const namesOrCount = (names: ReadonlyArray<string>, total: number, noun: string): string =>
  names.length === total && total > 0 && total <= 3
    ? Arr.join(names, ", ")
    : countLabel(total, noun);

const peerSummary = (details: PeerDetails): CompactSummary =>
  details.total === 0
    ? { subject: "none", counters: ["no shared directory"], outcome: "returned" }
    : {
        subject: namesOrCount(
          Arr.map(details.peers, (peer) => peer.name),
          details.total,
          "other subagent",
        ),
        counters: ["share this directory"],
        outcome: "returned",
      };

const completedSummary = (details: CompletedDetails): CompactSummary => {
  const finished = details.total - details.failed;
  const outcome = details.failed ? "error" : details.warnings ? "warning" : "success";
  // A single report's icon says how it ended; several get counts.
  const subject =
    details.total === 1 && details.name
      ? details.name
      : Fn.pipe(
          [
            finished ? `${finished} finished` : "",
            details.failed ? `${details.failed} failed` : "",
            details.warnings ? `${details.warnings} with warnings` : "",
          ],
          Arr.filter(Boolean),
          Arr.join(", "),
        );
  return { subject, outcome };
};

const stoppedSummary = (details: StoppedDetails): CompactSummary => {
  const names = Arr.map(details.runs ?? [], (run) => run.name);
  const subject =
    names.length === 0 && details.total === 1 && details.name
      ? details.name
      : namesOrCount(names, details.total, "subagent");
  return {
    subject,
    ...(details.cause && { counters: [STOP_CAUSES[details.cause]] }),
    outcome: "warning",
  };
};

const notificationHeading = (
  customType: string | undefined,
  details: NoticeDetails | undefined,
): NoticeHeading => {
  if (details?.kind === "question")
    return {
      name: "agent_question",
      label: "Agent question",
      summary: { subject: details.name ?? "a subagent", outcome: "attention" },
    };
  if (details?.kind === "stopped" && details.total > 0)
    return { name: "agent_stopped", label: "Agents stopped", summary: stoppedSummary(details) };
  if (details?.kind === "peers")
    return { name: "agent_peers", label: "Agent peers", summary: peerSummary(details) };
  if (
    details?.kind === "completed" &&
    details.total > 0 &&
    details.failed <= details.total &&
    details.warnings <= details.total
  )
    return { name: "agent_report", label: "Agent report", summary: completedSummary(details) };
  return (
    UNTYPED_NOTICES.get(customType ?? "") ?? {
      name: "agent_update",
      label: "Agent update",
      summary: { subject: "a subagent", outcome: "returned" },
    }
  );
};

const expansionLabel = (details: NoticeDetails | undefined): string => {
  if (details === undefined) return "message";
  return Match.value(details).pipe(
    Match.when({ kind: "question" }, () => "question"),
    Match.when({ kind: "stopped" }, () => "list"),
    Match.when({ kind: "peers" }, () => "peers"),
    Match.when({ kind: "completed" }, (completed) =>
      completed.failed === completed.total
        ? countLabel(completed.total, "failure detail")
        : countLabel(completed.total, "report"),
    ),
    Match.orElse(() => "message"),
  );
};

const runNotes = (run: NoticeRun): ReadonlyArray<string> => [
  ...(run.textCut ? ["The rest of this report is in its saved file"] : []),
  ...(run.notes ?? []),
];

/** Details saved before display copies existed carry only counts for the heading. */
const hasDisplayCopy = (details: NoticeDetails | undefined): boolean => {
  if (details === undefined) return false;
  return Match.value(details).pipe(
    Match.when({ kind: "completed" }, (completed) => (completed.runs?.length ?? 0) > 0),
    Match.when({ kind: "question" }, (question) => question.question !== undefined),
    Match.when({ kind: "stopped" }, (stopped) => stopped.runs !== undefined),
    Match.when({ kind: "peers" }, () => true),
    Match.exhaustive,
  );
};

/** The body a notice shows below its heading; undefined when its details carry no display copy. */
const noticeBody = (
  details: NoticeDetails | undefined,
  width: number,
  theme: Theme,
  expanded: boolean,
  indent = 2,
): string[] | undefined => {
  if (details?.kind === "completed" && details.runs !== undefined && details.runs.length > 0) {
    const [only] = details.runs;
    const words =
      details.runs.length === 1 && only !== undefined
        ? [
            ...agentTextLines(only.text, width, theme, { expanded, indent }),
            ...Arr.flatMap(runNotes(only), (note) =>
              indentedLines(theme.fg("muted", sanitizeTerminalLine(note)), width, indent),
            ),
          ]
        : agentTextBlockLines(
            Arr.map(details.runs, (run) => {
              const kind = run.outcome === "failed" ? "failed" : "done";
              return {
                glyph: managerActivityGlyph(kind),
                tone: managerActivityColor(kind),
                name: run.name,
                text: run.text,
                notes: runNotes(run),
              };
            }),
            width,
            theme,
            expanded,
          );
    if (!expanded) return words;
    return [
      ...words,
      ...detailsSectionLines(
        Arr.flatMap(details.runs, (run) => [
          `${run.name}: ${Arr.join(run.facts ?? [`ID ${run.id}`], " · ")}`,
        ]),
        width,
        theme,
      ),
    ];
  }
  if (details?.kind === "question" && details.question !== undefined)
    return [
      ...agentTextLines(details.question, width, theme, { expanded, indent }),
      ...(expanded && details.id ? detailsSectionLines([`ID ${details.id}`], width, theme) : []),
    ];
  if (details?.kind === "stopped" && details.runs !== undefined) {
    const stopped = details.runs;
    const hidden = details.total - stopped.length;
    const note = indentedLines(
      theme.fg("muted", "They won't report; partial work they left in the checkout remains."),
      width,
      indent,
    );
    if (!expanded) return note;
    return [
      ...Arr.map(stopped, (run) =>
        clipToWidth(
          `  ${theme.fg("muted", managerActivityGlyph("stopped"))} ${sanitizeTerminalLine(run.name)} ${theme.fg("muted", `· was ${sanitizeTerminalLine(run.state)}`)}`,
          width,
        ),
      ),
      ...(hidden > 0
        ? [clipToWidth(theme.fg("dim", `  … ${countLabel(hidden, "more")}`), width)]
        : []),
      ...note,
      ...detailsSectionLines(
        Arr.map(stopped, (run) => `${run.name}: ID ${run.id}`),
        width,
        theme,
      ),
    ];
  }
  if (details?.kind === "peers") {
    const rows = Arr.map(details.peers, (peer) =>
      clipToWidth(
        `${Str.repeat(indent)(" ")}${theme.fg("toolTitle", sanitizeTerminalLine(peer.name))}${theme.fg("muted", ` · ${sanitizeTerminalLine(peer.ownership)} · ${sanitizeTerminalLine(peer.state)}${peer.task ? ` · ${sanitizeTerminalLine(peer.task)}` : ""}`)}`,
        width,
      ),
    );
    if (!expanded) return rows.length > 0 ? rows.slice(0, 3) : [];
    return [
      ...rows,
      ...detailsSectionLines(
        [
          ...(details.ownership ? [`This agent: ${details.ownership}`] : []),
          ...Arr.map(details.peers, (peer) => `${peer.name}: ID ${peer.id}`),
        ],
        width,
        theme,
      ),
    ];
  }
  return undefined;
};

/** A subagent notice: what happened as its heading, then the words agents wrote. */
export const presentSubagentNotification: CodePreviewMessagePresenter = (input, options, theme) => {
  const envelope = Option.getOrUndefined(decodeMessageEnvelope(input));
  const details = Option.getOrUndefined(decodeDetails(envelope?.details));
  const presentation = notificationHeading(envelope?.customType, details);
  // Without a display copy, expansion keeps the notice as the agent received it.
  if (!hasDisplayCopy(details))
    return {
      ...presentation,
      expandLabel: expansionLabel(details),
      expanded: () => new Text(stripTerminalControls(messageContentText(envelope?.content)), 0, 0),
    };
  const body = (expanded: boolean) => () =>
    composeToolComponent(
      (width) =>
        noticeBody(details, width, theme, expanded, bodyIndent({ ...options, expanded })) ?? [],
    );
  return { ...presentation, collapsed: body(false), expanded: body(true) };
};
