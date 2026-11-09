import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import * as Match from "effect/Match";
import { countLabel, nameListForms } from "pi-cosmic-core/display";
import { sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core/security";
import { clipToWidth, managerActivityGlyph, managerActivityColor } from "pi-cosmic-ui/manager";
import { composeToolComponent } from "pi-cosmic-ui/tool";
import type { CodePreviewMessagePresenter, CompactIssue, CompactSummary } from "pi-code-previews";
import { quoteText } from "pi-cosmic-core/message-text";
import { QUOTED_TEXT_LIMIT } from "../tools/compact-run-issues.ts";
import {
  agentTextBlockLines,
  agentTextLines,
  bodyIndent,
  expandedRowsBody,
  factRowLines,
  indentedBody,
  indentedLines,
} from "./agent-text.ts";
import { agentFactLines, savedAgentFactLines } from "./run-facts.ts";
import { decodeMessageEnvelope, messageContentText } from "./message-envelope.ts";
import { NoticeDetailsSchema, type NoticeDetails } from "./notice-details.ts";

const decodeDetails = Schema.decodeUnknownOption(NoticeDetailsSchema, {
  onExcessProperty: "ignore",
});

// Notices saved before display copies: which notice it was, from its message type.
const UNTYPED_NOTICES = new Map<string, NoticeHeading>([
  [
    "pi-subagents-proxy-notification",
    {
      name: "descendant_update",
      label: "Descendant update",
      summary: { subject: "from a subagent you started", outcome: "returned" },
    },
  ],
  [
    "pi-subagents-peer-notice",
    {
      name: "shared_checkout",
      label: "Shared checkout",
      summary: { subject: "other agents in this directory", outcome: "returned" },
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

/**
 * A few names, `auth-review, db-migration`, narrowing to `auth-review +1` and then the count where
 * the row has no room, since the names are the only place the row says how many; more read as the
 * count.
 */
const namesOrCount = (
  names: ReadonlyArray<string>,
  total: number,
  noun: string,
): Pick<CompactSummary, "subject" | "subjectAlternatives"> => {
  const count = countLabel(total, noun);
  if (names.length !== total || total === 0 || total > 3) return { subject: count };
  const [subject = count, ...narrower] = nameListForms(names);
  return total === 1 ? { subject } : { subject, subjectAlternatives: [...narrower, count] };
};

const peerSummary = (details: PeerDetails): CompactSummary =>
  details.total === 0
    ? { subject: "no other agents in this directory", outcome: "returned" }
    : {
        ...namesOrCount(
          Arr.map(details.peers, (peer) => peer.name),
          details.total,
          "other subagent",
        ),
        counters: [details.total === 1 ? "also works here" : "also work here"],
        outcome: "returned",
      };

/**
 * A failed run's words are a diagnostic: the row names the cause in a short issue and keeps the raw
 * text, such as a provider error and its stack, as the issue's expanded detail.
 */
const failureIssues = (details: CompletedDetails): CompactIssue[] => {
  const single = (details.runs?.length ?? 0) === 1;
  return Arr.flatMap(details.runs ?? [], (run): CompactIssue[] => {
    if (run.outcome !== "failed") return [];
    const { line, detail } = quoteText(run.text ?? "", {
      limit: QUOTED_TEXT_LIMIT,
      failure: true,
    });
    const cause = line ?? "Failed";
    return [
      {
        severity: "error",
        code: `run:${run.id}:failed`,
        message: single ? cause : `${sanitizeTerminalLine(run.name)}: ${cause}`,
        ...(detail && { detail }),
      },
    ];
  });
};

const completedSummary = (details: CompletedDetails): CompactSummary => {
  const finished = details.total - details.failed;
  const outcome = details.failed ? "error" : details.warnings ? "warning" : "success";
  const issues = failureIssues(details);
  // A single report's icon says how it ended; several get counts.
  if (details.total === 1 && details.name)
    return { subject: details.name, outcome, ...(issues.length > 0 && { issues }) };
  const counts = Arr.filter(
    [
      finished ? `${finished} finished` : "",
      details.failed ? `${details.failed} failed` : "",
      details.warnings ? `${details.warnings} with warnings` : "",
    ],
    Str.isNonEmpty,
  );
  // Counter alternatives, widest first, so a narrow heading keeps the whole counts that fit.
  return {
    subject: "",
    counters: Arr.map(Arr.reverse(Arr.range(1, counts.length)), (shown) =>
      Arr.join(Arr.take(counts, shown), " · "),
    ),
    outcome,
    ...(issues.length > 0 && { issues }),
  };
};

const stoppedSummary = (details: StoppedDetails): CompactSummary => {
  const names = Arr.map(details.runs ?? [], (run) => run.name);
  const subject =
    names.length === 0 && details.total === 1 && details.name
      ? { subject: details.name }
      : namesOrCount(names, details.total, "subagent");
  // A routine stop: the runs were stopped on purpose, which is no warning.
  return {
    ...subject,
    ...(details.cause && { counters: [STOP_CAUSES[details.cause]] }),
    outcome: "cancelled",
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
    return {
      name: "subagents_stopped",
      label: "Subagents stopped",
      summary: stoppedSummary(details),
    };
  if (details?.kind === "peers")
    return { name: "shared_checkout", label: "Shared checkout", summary: peerSummary(details) };
  if (
    details?.kind === "completed" &&
    details.total > 0 &&
    details.failed <= details.total &&
    details.warnings <= details.total
  )
    return { name: "agent_report", label: "Agent report", summary: completedSummary(details) };
  return (
    UNTYPED_NOTICES.get(customType ?? "") ?? {
      name: "subagent_update",
      label: "Subagent update",
      summary: { subject: "from a subagent", outcome: "returned" },
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

interface NoticeBody {
  /** The rows beneath the heading: the words agents wrote and short notes. */
  readonly rows: (width: number) => string[];
  /** Technical facts shown only expanded, in the `Details` section. */
  readonly facts: ReadonlyArray<string>;
  /**
   * What expansion reveals beyond the collapsed rows, which clip agents' words with their own
   * affordance; undefined when it adds nothing.
   */
  readonly expandLabel?: string | undefined;
  /** The label of the agents' words beneath an expanded heading that wraps. */
  readonly label?: string | undefined;
}

const completedBody = (
  runs: NonNullable<CompletedDetails["runs"]>,
  theme: Theme,
  expanded: boolean,
  indent: number,
): NoticeBody => {
  const [only] = runs;
  return {
    rows: (width) =>
      // A failure's words are its heading issue and that issue's detail.
      runs.length === 1 && only !== undefined
        ? [
            ...(only.outcome === "failed"
              ? []
              : agentTextLines(only.text, width, theme, { expanded, indent })),
            ...Arr.flatMap(only.notes ?? [], (note) =>
              indentedLines(theme.fg("muted", sanitizeTerminalLine(note)), width, indent),
            ),
          ]
        : agentTextBlockLines(
            Arr.map(runs, (run) => {
              const kind = run.outcome === "failed" ? "failed" : "done";
              return {
                glyph: managerActivityGlyph(kind),
                tone: managerActivityColor(kind),
                name: run.name,
                ...(run.outcome !== "failed" && { text: run.text }),
                notes: run.notes ?? [],
              };
            }),
            width,
            theme,
            expanded,
          ),
    facts: Arr.flatMap(runs, (run) => savedAgentFactLines(run.name, run.facts ?? [run.id])),
    expandLabel: "details",
    // A lone failure's body is only its notes; its words are the heading's issue.
    ...(runs.length > 1 ? { label: "Reports" } : only?.outcome !== "failed" && { label: "Report" }),
  };
};

const stoppedBody = (
  details: StoppedDetails,
  stopped: NonNullable<StoppedDetails["runs"]>,
  theme: Theme,
  expanded: boolean,
  indent: number,
): NoticeBody => {
  const hidden = details.total - stopped.length;
  const pad = Str.repeat(indent)(" ");
  const note = (width: number) =>
    indentedLines(
      theme.fg("muted", "They won't report; partial work they left in the checkout remains."),
      width,
      indent,
    );
  return {
    rows: (width) =>
      expanded
        ? [
            ...Arr.map(stopped, (run) =>
              clipToWidth(
                `${pad}${theme.fg("muted", managerActivityGlyph("stopped"))} ${sanitizeTerminalLine(run.name)} ${theme.fg("muted", `· was ${sanitizeTerminalLine(run.state)}`)}`,
                width,
              ),
            ),
            ...(hidden > 0
              ? [clipToWidth(theme.fg("dim", `${pad}… ${countLabel(hidden, "more")}`), width)]
              : []),
            ...note(width),
          ]
        : note(width),
    facts: Arr.flatMap(stopped, (run) => agentFactLines(run.name, [run.id])),
    ...(stopped.length > 0 && { expandLabel: countLabel(details.total, "stopped run") }),
  };
};

const peersBody = (details: PeerDetails, theme: Theme, expanded: boolean, indent: number) =>
  ({
    // Collapsed, each peer keeps one clipped row; expanded, its whole task wraps beneath it.
    rows: (width: number) =>
      Arr.flatMap(expanded ? details.peers : details.peers.slice(0, 3), (peer) =>
        factRowLines(
          [
            [sanitizeTerminalLine(peer.name), "toolTitle"],
            [
              ` · ${sanitizeTerminalLine(peer.ownership)} · ${sanitizeTerminalLine(peer.state)}${peer.task ? ` · ${sanitizeTerminalLine(peer.task)}` : ""}`,
              "muted",
            ],
          ],
          width,
          theme,
          expanded,
          { indent },
        ),
      ),
    facts: [
      ...(details.ownership ? [`This agent: ${details.ownership}`] : []),
      ...Arr.flatMap(details.peers, (peer) => agentFactLines(peer.name, [peer.id])),
    ],
    // Expansion wraps each peer's whole task and names this agent's role and each peer's ID.
    ...((details.ownership !== undefined || details.peers.length > 0) && {
      expandLabel: details.peers.length > 3 ? countLabel(details.peers.length, "peer") : "details",
    }),
    label: "Agents",
  }) satisfies NoticeBody;

/** The body a notice shows below its heading; undefined when its details carry no display copy. */
const noticeBody = (
  details: NoticeDetails | undefined,
  theme: Theme,
  expanded: boolean,
  indent: number,
): NoticeBody | undefined => {
  if (details?.kind === "completed" && details.runs !== undefined && details.runs.length > 0)
    return completedBody(details.runs, theme, expanded, indent);
  if (details?.kind === "question" && details.question !== undefined) {
    const question = details.question;
    return {
      rows: (width) => agentTextLines(question, width, theme, { expanded, indent }),
      facts: details.id ? agentFactLines(details.name ?? details.id, [details.id]) : [],
      ...(details.id !== undefined && { expandLabel: "details" }),
      label: "Question",
    };
  }
  if (details?.kind === "stopped" && details.runs !== undefined)
    return stoppedBody(details, details.runs, theme, expanded, indent);
  if (details?.kind === "peers") return peersBody(details, theme, expanded, indent);
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
      expanded: () =>
        indentedBody(
          theme,
          new Text(stripTerminalControls(messageContentText(envelope?.content)), 0, 0),
        ),
    };
  const shape = noticeBody(details, theme, true, 0);
  return {
    ...presentation,
    ...(shape?.expandLabel !== undefined && { expandLabel: shape.expandLabel }),
    ...(shape?.label !== undefined && { bodyLabel: shape.label }),
    collapsed: () =>
      composeToolComponent(
        (width) =>
          noticeBody(details, theme, false, bodyIndent({ ...options, expanded: false }))?.rows(
            width,
          ) ?? [],
      ),
    expanded: () => {
      const body = noticeBody(details, theme, true, 0);
      return body
        ? expandedRowsBody(theme, body.rows, body.facts)
        : indentedBody(theme, new Text("", 0, 0));
    },
  };
};
