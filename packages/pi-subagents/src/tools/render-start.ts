import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { previewIssuesSlot } from "pi-code-previews";
import { countLabel } from "pi-cosmic-core/display";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { synchronousNow } from "pi-cosmic-core/platform/native-clock";
import {
  managerStateGlyph,
  startingSpinnerFrame,
  clipToWidth,
  spinnerFrameAt,
} from "pi-cosmic-ui/manager";
import {
  composeToolComponent as renderComponent,
  renderToolHeader,
  toolStatusLine,
} from "pi-cosmic-ui/tool";
import { agentTextLines, detailsSectionLines, indentedLines } from "../ui/agent-text.ts";
import { formatRunRouteLine } from "../ui/run-presentation.ts";
import type { SubagentStartEntry } from "./details-schema.ts";
import type { SubagentStartFailure } from "./model.ts";
import { isTextFragment } from "./text-fragments.ts";

// Raw call arguments reach the renderer before Pi validates them, and models send null for absent
// fields; a malformed field or entry renders as absent instead of failing the row.
const lenient = <S extends Schema.Top>(schema: S) =>
  Schema.optional(schema.pipe(Schema.catchDecoding(() => Effect.succeedNone)));
const RequestedStart = Schema.Struct({
  name: lenient(Schema.String),
  agent: lenient(Schema.String),
  profile: lenient(Schema.String),
  task: lenient(Schema.String),
  isolation: lenient(Schema.String),
  model: lenient(
    Schema.Struct({
      model: Schema.String,
      effort: lenient(Schema.String),
    }),
  ),
}).pipe(Schema.catchDecoding(() => Effect.succeedSome({})));
type RequestedStart = typeof RequestedStart.Type;
const RequestedStarts = Schema.Array(RequestedStart);

const requestedName = (agent: RequestedStart, index: number): string =>
  sanitizeTerminalLine(Str.trim(agent.name ?? "") || `launch ${index + 1}`);

// A custom agent names its own role; its profile is resolved at launch.
const requestedProfile = (agent: RequestedStart): string =>
  sanitizeTerminalLine(
    Str.trim(agent.agent ?? "") || Str.trim(agent.profile ?? "") || "generalist",
  );

const firstLine = (text: string | undefined): string =>
  sanitizeTerminalLine(Str.split(Str.trim(text ?? ""), "\n")[0] ?? "");

const requestRoute = (agent: RequestedStart): string =>
  Fn.pipe(
    [
      `${Str.trim(agent.agent ?? "") ? "agent" : "profile"} ${requestedProfile(agent)}`,
      agent.model
        ? `model ${sanitizeTerminalLine(`${agent.model.model}${agent.model.effort === undefined ? "" : `:${agent.model.effort}`}`)}`
        : undefined,
      agent.isolation === undefined
        ? undefined
        : `isolation ${sanitizeTerminalLine(agent.isolation)}`,
    ],
    Arr.filter(isTextFragment),
    Arr.join(" · "),
  );

const COLLAPSED_LAUNCHES = 6;

/**
 * The launches a call requests: each name with the first line of its task collapsed, and its whole
 * task with its requested profile, model, and isolation expanded.
 */
export const renderSubagentStartCall = (
  requested: unknown,
  theme: Theme,
  expanded: boolean,
  contentOnly = false,
  context?: { readonly state: object },
): Component => {
  const agents = Option.getOrElse(Schema.decodeUnknownOption(RequestedStarts)(requested), () => []);
  const title =
    agents.length === 0 ? "Start subagents" : `Start ${countLabel(agents.length, "subagent")}`;
  const container = new Container();
  if (!contentOnly) {
    container.addChild(new Text(renderToolHeader({ title }, theme), 0, 0));
    if (context) container.addChild(previewIssuesSlot(context));
  }
  container.addChild(
    renderComponent((width) => {
      const safeWidth = Math.max(1, width);
      const shown = expanded ? agents : agents.slice(0, COLLAPSED_LAUNCHES);
      const hidden = agents.length - shown.length;
      return [
        ...Arr.flatMap(shown, (agent, index) => {
          const name = theme.fg("toolTitle", requestedName(agent, index));
          if (!expanded) {
            const task = firstLine(agent.task);
            return [
              clipToWidth(`${name}${task ? theme.fg("muted", ` · ${task}`) : ""}`, safeWidth),
            ];
          }
          return [
            clipToWidth(name, safeWidth),
            ...agentTextLines(agent.task, safeWidth, theme, { expanded: true }),
            ...indentedLines(theme.fg("dim", requestRoute(agent)), safeWidth),
          ];
        }),
        ...(hidden > 0
          ? [
              clipToWidth(
                theme.fg("dim", `… ${countLabel(hidden, "more launch", "more launches")}`),
                safeWidth,
              ),
            ]
          : []),
      ];
    }),
  );
  return container;
};

const entryFact = (
  entry: SubagentStartEntry,
  failure: SubagentStartFailure | undefined,
): string => {
  const runId = Match.value(entry).pipe(
    Match.when({ status: "started" }, (started) => started.runId),
    Match.orElse(() => failure?.admittedRun?.runId),
  );
  const role = entry.agent ? `${entry.agent} (${entry.profile})` : entry.profile || "generalist";
  const route =
    entry.routeStatus === "selected"
      ? formatRunRouteLine({ ...entry, profile: role })
      : entry.status === "pending"
        ? `${role} · resolving its route`
        : `${role} · no eligible route`;
  const fallback =
    entry.routeStatus === "selected" &&
    entry.candidateIndex !== undefined &&
    entry.candidateIndex > 0
      ? `candidate ${entry.candidateIndex + 1} after ${countLabel(entry.candidateIndex, "unavailable one")}`
      : undefined;
  return Fn.pipe([runId, route, fallback], Arr.filter(isTextFragment), Arr.join(" · "));
};

const receiptStatus = (
  entries: ReadonlyArray<SubagentStartEntry>,
  partial: boolean,
  theme: Theme,
): string | undefined => {
  const started = Arr.filter(entries, (entry) => entry.status === "started");
  const failed = Arr.filter(entries, (entry) => entry.status === "failed").length;
  if (partial)
    return toolStatusLine(
      theme,
      "running",
      `Launching ${started.length + failed} of ${entries.length}`,
      spinnerFrameAt(synchronousNow()),
    );
  if (started.length === 0) return undefined;
  return `${theme.fg("success", managerStateGlyph("done"))} ${theme.fg("muted", "Started")} ${theme.fg(
    "toolTitle",
    Arr.join(
      Arr.map(started, (entry) => sanitizeTerminalLine(entry.name)),
      ", ",
    ),
  )}`;
};

/**
 * A start's receipt: which launches started, as one line, or live progress while they launch.
 * Launch failures are the call's issues; expansion adds each launch's route and run ID, and the
 * raw failure of each that couldn't start.
 */
export const renderStartReceiptComponent = (
  receipt: {
    readonly startEntries: ReadonlyArray<SubagentStartEntry>;
    readonly startFailures?: ReadonlyArray<SubagentStartFailure> | undefined;
  },
  expanded: boolean,
  theme: Theme,
  partial = false,
): Component =>
  renderComponent((width) => {
    const safeWidth = Math.max(1, width);
    const entries = receipt.startEntries;
    const status = receiptStatus(entries, partial, theme);
    const pending = partial ? Arr.filter(entries, (entry) => entry.status === "pending") : [];
    return [
      ...(status ? [clipToWidth(status, safeWidth)] : []),
      ...Arr.map(pending, (entry) =>
        clipToWidth(
          `  ${theme.fg("warning", startingSpinnerFrame(0))} ${sanitizeTerminalLine(entry.name)} ${theme.fg("muted", "· starting")}`,
          safeWidth,
        ),
      ),
      ...(expanded
        ? detailsSectionLines(
            Arr.flatMap(entries, (entry) => {
              const failure = Option.getOrUndefined(
                Arr.findFirst(
                  receipt.startFailures ?? [],
                  (candidate) => candidate.index === entry.index,
                ),
              );
              // A failure's message and recovery facts are its issue's detail.
              return [`${sanitizeTerminalLine(entry.name)}: ${entryFact(entry, failure)}`];
            }),
            safeWidth,
            theme,
          )
        : []),
    ];
  });
