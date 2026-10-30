import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { countLabel } from "pi-cosmic-core/display";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { formatRunRoute } from "../ui/run-presentation.ts";
import {
  composeToolComponent as renderComponent,
  renderExpansionAffordance,
} from "pi-cosmic-ui/tool";
import type {
  CompactSubagentToolDetails,
  SubagentProfileCandidateCard,
  SubagentProfileRouteCard,
} from "./details-schema.ts";
import { COLLAPSED_AGENT_TEXT_ROWS, detailsSectionLines } from "../ui/agent-text.ts";
import { cardFactLines, stateGroupLines } from "./render-run-cards.ts";

type ModelsToolDetails = Extract<CompactSubagentToolDetails, { readonly action: "models" }>;
type RunToolDetails = Exclude<CompactSubagentToolDetails, ModelsToolDetails>;
type AgentRouteCard = NonNullable<ModelsToolDetails["agents"]>[number];

const candidateRoute = (candidate: SubagentProfileCandidateCard): string =>
  formatRunRoute({
    ...candidate,
    openaiFastMode: candidate.openaiFastMode && candidate.status === "eligible",
  });

const PROFILE_SOURCE_LABELS = {
  session: "session override",
  project: "project override",
  "project-invalid": "invalid project override",
  global: "global override",
  "global-invalid": "invalid global override",
  builtin: undefined,
} as const satisfies Record<SubagentProfileRouteCard["source"], string | undefined>;

interface RouteRow {
  readonly name: string;
  /** The model a launch would take, or why none would run. */
  readonly route: string;
  readonly writeIntent: string;
  readonly source?: string | undefined;
  readonly attention: boolean;
}

/** The first eligible candidate's model, `disabled` without candidates, or `unavailable`. */
const effectiveRoute = (
  candidates: ReadonlyArray<SubagentProfileCandidateCard>,
  invalid: boolean,
): Pick<RouteRow, "route" | "attention"> & { readonly writeIntent?: string } => {
  if (invalid) return { route: "invalid settings", attention: true };
  const eligible = Arr.findFirst(candidates, (candidate) => candidate.status === "eligible");
  if (Option.isSome(eligible))
    return {
      route: candidateRoute(eligible.value),
      writeIntent: eligible.value.writeIntent,
      attention: false,
    };
  return candidates.length === 0
    ? { route: "disabled", attention: false }
    : { route: "unavailable", attention: true };
};

export const profileRow = (profile: SubagentProfileRouteCard): RouteRow => {
  const invalid = Fn.pipe(profile.source, Str.endsWith("-invalid"));
  const { writeIntent, ...effective } = effectiveRoute(profile.candidates, invalid);
  return {
    name: profile.id,
    ...effective,
    writeIntent: writeIntent ?? profile.defaultWriteIntent,
    source: PROFILE_SOURCE_LABELS[profile.source],
  };
};

const agentRow = (agent: AgentRouteCard): RouteRow => {
  const { writeIntent, ...effective } = effectiveRoute(agent.candidates, false);
  return {
    name: agent.name,
    ...effective,
    writeIntent: agent.writeIntent ?? writeIntent ?? "read-only",
    source: `${agent.source} agent`,
  };
};

const routeRowLine = (row: RouteRow, width: number, theme: Theme): string =>
  clipToWidth(
    `${theme.fg(row.attention ? "warning" : "muted", "•")} ${theme.fg("toolTitle", sanitizeTerminalLine(row.name))}${theme.fg(
      row.attention ? "warning" : "muted",
      ` · ${sanitizeTerminalLine(row.route)}`,
    )}${theme.fg("muted", ` · ${row.writeIntent}${row.source ? ` · ${row.source}` : ""}`)}`,
    width,
  );

const eligibleCount = (candidates: ReadonlyArray<SubagentProfileCandidateCard>): string =>
  `${Arr.filter(candidates, (candidate) => candidate.status === "eligible").length}/${candidates.length} eligible`;

/** Each candidate in route order; a skipped one gives its reason. */
const candidateFacts = (
  candidates: ReadonlyArray<SubagentProfileCandidateCard>,
): ReadonlyArray<string> =>
  Arr.map(
    candidates,
    (candidate, index) =>
      `  ${index + 1}. ${candidateRoute(candidate)} · ${candidate.context} · ${candidate.writeIntent}${candidate.status === "skipped" ? ` · skipped: ${candidate.reason}` : ""}`,
  );

const profileFacts = (profile: SubagentProfileRouteCard): ReadonlyArray<string> => [
  `${profile.id}: ${eligibleCount(profile.candidates)} · defaults ${profile.defaultContext} · ${profile.defaultWriteIntent} · ${profile.defaultEffort ?? "inherited"} effort`,
  ...candidateFacts(profile.candidates),
];

const agentFacts = (agent: AgentRouteCard): ReadonlyArray<string> => [
  `${agent.name}: profile ${agent.profile} · ${eligibleCount(agent.candidates)}${Arr.join(
    Arr.map(
      Arr.filter(
        [
          agent.context,
          agent.effort && `${agent.effort} effort`,
          agent.isolation && `isolation ${agent.isolation}`,
          agent.allowedToolCount !== undefined &&
            countLabel(agent.allowedToolCount, "allowed tool"),
          agent.deniedToolCount !== undefined && countLabel(agent.deniedToolCount, "denied tool"),
        ],
        Predicate.isString,
      ),
      (fact) => ` · ${fact}`,
    ),
    "",
  )}`,
  ...candidateFacts(agent.candidates),
];

/**
 * Profile routes as the user reads them: one line per profile and custom agent with the model a
 * launch would take, whether it writes, and where a non-built-in route comes from. Expansion adds
 * eligibility, context, effort, and each candidate among the details.
 */
export const renderProfileRoutesComponent = (
  details: ModelsToolDetails,
  expanded: boolean,
  theme: Theme,
): Component =>
  renderComponent((width) => {
    const safeWidth = Math.max(1, width);
    const agents = details.agents ?? [];
    const rows = [...Arr.map(details.profiles, profileRow), ...Arr.map(agents, agentRow)];
    const shown =
      expanded || rows.length <= COLLAPSED_AGENT_TEXT_ROWS + 1
        ? rows
        : rows.slice(0, COLLAPSED_AGENT_TEXT_ROWS);
    const hidden = rows.length - shown.length;
    return [
      ...(rows.length === 0 ? [theme.fg("muted", "No profile routes were recorded")] : []),
      ...Arr.map(shown, (row) => routeRowLine(row, safeWidth, theme)),
      ...(hidden > 0
        ? [
            clipToWidth(
              renderExpansionAffordance(countLabel(hidden, "more route"), false, theme),
              safeWidth,
            ),
          ]
        : []),
      ...(details.contentOmitted
        ? [clipToWidth(theme.fg("dim", "Some route details were too long to keep"), safeWidth)]
        : []),
      ...(expanded
        ? detailsSectionLines(
            [
              `Fallback profile: ${details.fallbackProfile}`,
              ...Arr.flatMap(details.profiles, profileFacts),
              ...Arr.flatMap(agents, agentFacts),
              ...Arr.map(
                details.invalidAgents ?? [],
                (agent) => `Invalid ${agent.scope} agent${agent.name ? `: ${agent.name}` : ""}`,
              ),
            ],
            safeWidth,
            theme,
          )
        : []),
    ];
  });

/**
 * A stop or interrupt: its targets grouped by the state they reached, then, expanded, each run's
 * technical facts and the raw failures of targets it couldn't act on.
 */
export const renderCompactResultComponent = (
  details: RunToolDetails,
  expanded: boolean,
  theme: Theme,
): Component =>
  renderComponent((width) => {
    const safeWidth = Math.max(1, width);
    // Each failure's message is its issue's detail; the details name the target and code.
    const failures = Arr.map(
      details.actionFailures ?? [],
      (failure) =>
        `${sanitizeTerminalLine(failure.id)}: not ${details.action === "stop" ? "stopped" : "interrupted"}${failure.code ? ` · ${sanitizeTerminalLine(failure.code)}` : ""}`,
    );
    return [
      ...stateGroupLines(details.cards, safeWidth, theme),
      ...(expanded
        ? detailsSectionLines(
            [...Arr.flatMap(details.cards, cardFactLines), ...failures],
            safeWidth,
            theme,
          )
        : []),
    ];
  });
