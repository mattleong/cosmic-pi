import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { escapeControlChars, expandedSection, previewIssuesSlot } from "pi-code-previews";
import { countLabel, sanitizeTerminalLine, synchronousNow } from "pi-cosmic-core";
import {
  managerStateGlyph,
  startingSpinnerFrame,
  clipToWidth,
  spinnerFrameAt,
} from "pi-cosmic-ui/manager";
import { duplicateRunNames, formatRunRoute, shortRunId } from "../ui/run-presentation.ts";
import { failureRecovery } from "./compact-action-failures.ts";
import type { SubagentStartEntry } from "./details-schema.ts";
import { boundedLine, failedStartRecoveryAction, formatFailedStartRecovery } from "./format.ts";
import {
  composeToolComponent as renderComponent,
  renderExpansionAffordance,
  renderToolHeader,
  toolStatusLine,
} from "pi-cosmic-ui/tool";
import type { SubagentStartFailure } from "./model.ts";

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
      runtime: Schema.String,
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
  const subtitle = Fn.pipe(
    agents,
    Arr.map((agent, index) => `${requestedName(agent, index)} [${requestedProfile(agent)}]`),
    Arr.join(", "),
  );
  const container = new Container();
  if (!contentOnly) {
    container.addChild(new Text(renderToolHeader({ title, subtitle }, theme), 0, 0));
    if (context) container.addChild(previewIssuesSlot(context));
  }
  if (!expanded) {
    container.addChild(
      new Text(renderExpansionAffordance("tasks & launch details", false, theme), 0, 0),
    );
    return container;
  }
  for (const [index, agent] of agents.entries()) {
    const route = agent.model
      ? `model override ${sanitizeTerminalLine(`${agent.model.runtime}/${agent.model.model}${agent.model.effort === undefined ? "" : `:${agent.model.effort}`}`)}`
      : "route/model selected at launch";
    const request = `${requestedName(agent, index)} · ${requestedProfile(agent)} · ${route}`;
    container.addChild(new Text(theme.fg("toolOutput", request), 0, 0));
    container.addChild(
      new Text(theme.fg("dim", `  Task: ${escapeControlChars(agent.task ?? "")}`), 0, 0),
    );
    if (agent.isolation !== undefined)
      container.addChild(
        new Text(theme.fg("dim", `  Isolation: ${escapeControlChars(agent.isolation)}`), 0, 0),
      );
  }
  return container;
};

const selectedRoute = (entry: SubagentStartEntry) => entry.routeStatus === "selected";

const routeLabel = (entry: SubagentStartEntry): string => {
  if (selectedRoute(entry)) return formatRunRoute(entry);
  return entry.status === "pending" ? "resolving route/model" : "no eligible route/model";
};

const receiptPresentation = (entry: SubagentStartEntry) => {
  switch (entry.status) {
    case "pending":
      return { glyph: startingSpinnerFrame(0), color: "warning" } as const;
    case "started":
      return { glyph: managerStateGlyph("done"), color: "success" } as const;
    case "failed":
      return { glyph: managerStateGlyph("failed"), color: "error" } as const;
  }
  return Fn.absurd<never>(entry);
};

interface ReceiptRowOptions {
  readonly expanded: boolean;
  readonly sharedNames: ReadonlySet<string>;
  readonly failure?: SubagentStartFailure | undefined;
}

const receiptRunId = (entry: SubagentStartEntry, options: ReceiptRowOptions): string => {
  const runId = Match.value(entry).pipe(
    Match.when({ status: "started" }, (started) => started.runId),
    Match.when({ status: "failed" }, () => options.failure?.admittedRun?.runId),
    Match.orElse(() => undefined),
  );
  if (runId === undefined) return "";
  if (options.expanded) return sanitizeTerminalLine(runId);
  return options.sharedNames.has(entry.name) ? sanitizeTerminalLine(shortRunId(runId)) : "";
};

const receiptRow = (
  entry: SubagentStartEntry,
  width: number,
  theme: Theme,
  options: ReceiptRowOptions,
): string[] => {
  const safeWidth = Math.max(1, width);
  const { glyph, color } = receiptPresentation(entry);
  const name = sanitizeTerminalLine(entry.name);
  // An agent's routed profile is known only once its route is selected.
  const profile = sanitizeTerminalLine(
    entry.agent
      ? entry.routeStatus === "selected"
        ? `${entry.agent} (${entry.profile})`
        : entry.agent
      : entry.profile || "generalist",
  );
  const route = routeLabel(entry);
  const id = receiptRunId(entry, options);
  const raw = `${glyph} ${name} · ${profile} · ${route}${id ? ` · ${id}` : ""}`;
  if (visibleWidth(raw) <= safeWidth)
    return [
      `${theme.fg(color, glyph)} ${theme.fg("toolTitle", name)} · ${theme.fg("muted", profile)} · ${theme.fg("toolOutput", route)}${id ? ` · ${theme.fg("muted", id)}` : ""}`,
    ];
  const lines = [`${theme.fg(color, glyph)} ${theme.fg("toolTitle", name)}`];
  const routeValue = `${theme.fg("muted", profile)} ${theme.fg("dim", "→")} ${theme.fg("toolOutput", route)}`;
  lines.push(
    ...Arr.map(
      wrapTextWithAnsi(routeValue, Math.max(1, safeWidth - 5)),
      (line, index) => `${theme.fg("dim", index === 0 ? "  ╰─ " : "     ")}${line}`,
    ),
  );
  if (id) lines.push(`  ${theme.fg("muted", id)}`);
  return Arr.map(lines, (line) => clipToWidth(line, safeWidth));
};

const receiptCounters = (
  entries: ReadonlyArray<SubagentStartEntry>,
  partial: boolean,
  theme: Theme,
): string => {
  const total = entries.length;
  const started = Arr.filter(entries, (entry) => entry.status === "started").length;
  const failed = Arr.filter(entries, (entry) => entry.status === "failed").length;
  const pending = total - started - failed;
  if (partial)
    return toolStatusLine(
      theme,
      "running",
      Arr.join(
        [
          `Launching ${started + failed} of ${total}`,
          `${started} started`,
          ...(failed > 0 ? [`${failed} failed`] : []),
          ...(pending > 0 ? [`${pending} pending`] : []),
        ],
        " · ",
      ),
      spinnerFrameAt(synchronousNow()),
    );
  if (total === 0) return theme.fg("muted", "No launch receipt");
  return theme.fg(
    "muted",
    Arr.join([`${started}/${total} started`, ...(failed > 0 ? [`${failed} failed`] : [])], " · "),
  );
};

const launchFailureSection = (
  entry: SubagentStartEntry,
  failure: SubagentStartFailure,
  theme: Theme,
): Component =>
  expandedSection(
    theme,
    `${sanitizeTerminalLine(entry.name)} couldn't start`,
    new Text(
      Arr.join(
        [
          theme.fg("toolOutput", boundedLine(failure.message, 2_048)),
          ...(failure.admittedRun
            ? [theme.fg("dim", formatFailedStartRecovery(failure.admittedRun))]
            : []),
          theme.fg(
            "dim",
            `Next: ${
              failure.admittedRun
                ? failedStartRecoveryAction(failure.admittedRun)
                : failureRecovery(failure.code, failure.message, "start")
            }`,
          ),
        ],
        "\n",
      ),
      0,
      0,
    ),
  );

const COLLAPSED_ROWS = 6;

export const renderStartReceiptComponent = (
  receipt: {
    readonly startEntries: ReadonlyArray<SubagentStartEntry>;
    readonly startFailures?: ReadonlyArray<SubagentStartFailure> | undefined;
  },
  expanded: boolean,
  theme: Theme,
  partial = false,
  contentOnly = false,
): Component =>
  renderComponent((width) => {
    const safeWidth = Math.max(1, width);
    const entries = receipt.startEntries;
    const started = Arr.filter(entries, (entry) => entry.status === "started").length;
    const sharedNames = duplicateRunNames(entries);
    const shown = expanded ? entries : entries.slice(0, COLLAPSED_ROWS);
    const rows = Arr.flatMap(shown, (entry) => {
      const failure =
        receipt.startFailures === undefined
          ? undefined
          : Option.getOrUndefined(
              Arr.findFirst(receipt.startFailures, (candidate) => candidate.index === entry.index),
            );
      const row = receiptRow(entry, safeWidth, theme, { expanded, sharedNames, failure });
      if (!expanded) return row;
      const fallback =
        selectedRoute(entry) && entry.candidateIndex !== undefined && entry.candidateIndex > 0
          ? `${entry.status === "started" ? "Selected" : "Attempted"} candidate ${entry.candidateIndex + 1} after ${countLabel(entry.candidateIndex, "earlier candidate")} ${entry.candidateIndex === 1 ? "was" : "were"} unavailable.`
          : undefined;
      return [
        ...row,
        ...(fallback ? wrapTextWithAnsi(theme.fg("dim", `  ${fallback}`), safeWidth) : []),
        ...(!contentOnly && entry.status === "failed" && failure
          ? launchFailureSection(entry, failure, theme).render(safeWidth)
          : []),
      ];
    });
    const hidden = entries.length - shown.length;
    return [
      ...(!contentOnly ? [clipToWidth(receiptCounters(entries, partial, theme), safeWidth)] : []),
      ...rows,
      ...(hidden > 0
        ? [
            clipToWidth(
              theme.fg("dim", `… ${countLabel(hidden, "more launch", "more launches")}`),
              safeWidth,
            ),
          ]
        : []),
      ...(!partial && started > 0
        ? [clipToWidth(theme.fg("dim", "→ /subagents for live status"), safeWidth)]
        : []),
    ];
  });
