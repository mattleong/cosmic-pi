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
import { COLLAPSED_AGENT_TEXT_ROWS, expandedRowsBody, factRowLines } from "../ui/agent-text.ts";
import { cardFactLines, stateGroupLines } from "./render-run-cards.ts";
import { findOrUndefined } from "pi-cosmic-core/array";

type ModelsToolDetails = Extract<CompactSubagentToolDetails, { readonly action: "models" }>;
type RunToolDetails = Exclude<CompactSubagentToolDetails, ModelsToolDetails>;
type AgentRouteCard = NonNullable<ModelsToolDetails["agents"]>[number];

/** What a route inherits from the caller: its model, and the effort an unpinned candidate takes. */
interface InheritedRoute {
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}

/** The caller's route, and the effort a profile's unpinned candidates take from it. */
const inheritedRoute = (
  details: Pick<ModelsToolDetails, "parentModel" | "parentEffort">,
  defaultEffort?: string,
): InheritedRoute => ({
  model: details.parentModel,
  effort: defaultEffort ?? details.parentEffort,
});

/**
 * A candidate's model and effort. One that runs on the caller's model reads as the model it
 * inherits, `inherit (provider/model)`, with the effort it pins, as other routes read.
 */
const candidateRoute = (
  candidate: SubagentProfileCandidateCard,
  inherited: InheritedRoute,
): string => {
  const pinned = candidate.effort === "default" ? undefined : candidate.effort;
  if (candidate.model === "parent") {
    const model =
      inherited.model === undefined
        ? "inherit"
        : `inherit (${sanitizeTerminalLine(inherited.model)})`;
    return pinned === undefined ? model : `${model}:${sanitizeTerminalLine(pinned)}`;
  }
  const effort = pinned ?? inherited.effort;
  const openaiFastMode = candidate.openaiFastMode && candidate.status === "eligible";
  return effort === undefined
    ? `${sanitizeTerminalLine(candidate.model)}${openaiFastMode ? " ⚡" : ""}`
    : formatRunRoute({ ...candidate, effort, openaiFastMode });
};

/** An effort a route doesn't pin reads as the one it inherits, `effort inherit (high)`. */
const effortFact = (effort: string | undefined, inherited: string | undefined): string =>
  effort !== undefined
    ? `effort ${effort}`
    : inherited === undefined
      ? "effort inherit"
      : `effort inherit (${inherited})`;

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
  inherited: InheritedRoute,
): Pick<RouteRow, "route" | "attention"> & { readonly writeIntent?: string } => {
  if (invalid) return { route: "invalid settings", attention: true };
  const eligible = Arr.findFirst(candidates, (candidate) => candidate.status === "eligible");
  if (Option.isSome(eligible))
    return {
      route: candidateRoute(eligible.value, inherited),
      writeIntent: eligible.value.writeIntent,
      attention: false,
    };
  return candidates.length === 0
    ? { route: "disabled", attention: false }
    : { route: "unavailable", attention: true };
};

export const profileRow = (
  profile: SubagentProfileRouteCard,
  details: Pick<ModelsToolDetails, "parentModel" | "parentEffort">,
): RouteRow => {
  const invalid = Fn.pipe(profile.source, Str.endsWith("-invalid"));
  const { writeIntent, ...effective } = effectiveRoute(
    profile.candidates,
    invalid,
    inheritedRoute(details, profile.defaultEffort),
  );
  return {
    name: profile.id,
    ...effective,
    writeIntent: writeIntent ?? profile.defaultWriteIntent,
    source: PROFILE_SOURCE_LABELS[profile.source],
  };
};

const agentRow = (agent: AgentRouteCard, details: ModelsToolDetails): RouteRow => {
  const { writeIntent, ...effective } = effectiveRoute(
    agent.candidates,
    false,
    inheritedRoute(details, agentDefaultEffort(agent, details)),
  );
  return {
    name: agent.name,
    ...effective,
    writeIntent: agent.writeIntent ?? writeIntent ?? "read-only",
    source: `${agent.source} agent`,
  };
};

const routeRowLines = (row: RouteRow, width: number, theme: Theme, expanded: boolean): string[] =>
  factRowLines(
    [
      ["•", row.attention ? "warning" : "muted"],
      [" "],
      [sanitizeTerminalLine(row.name), "toolTitle"],
      [` · ${sanitizeTerminalLine(row.route)}`, row.attention ? "warning" : "muted"],
      [` · ${row.writeIntent}${row.source ? ` · ${row.source}` : ""}`, "muted"],
    ],
    width,
    theme,
    expanded,
    { wholeFacts: true },
  );

const eligibleCount = (candidates: ReadonlyArray<SubagentProfileCandidateCard>): string =>
  `${Arr.countBy(candidates, (candidate) => candidate.status === "eligible")}/${candidates.length} eligible`;

/** The context and write intent a profile's or agent's line states, which its candidates needn't. */
interface CandidateDefaults {
  readonly context: string;
  readonly writeIntent: string;
}

/**
 * Each candidate in route order, with its context and write intent where they differ from the
 * defaults stated above it; a skipped one gives its reason.
 */
const candidateFacts = (
  candidates: ReadonlyArray<SubagentProfileCandidateCard>,
  inherited: InheritedRoute,
  defaults: Partial<CandidateDefaults>,
): ReadonlyArray<string> =>
  Arr.map(candidates, (candidate, index) =>
    Arr.join(
      Arr.filter(
        [
          `  ${index + 1}. ${candidateRoute(candidate, inherited)}`,
          candidate.context !== defaults.context && candidate.context,
          candidate.writeIntent !== defaults.writeIntent && candidate.writeIntent,
          candidate.status === "skipped" && `skipped: ${candidate.reason}`,
        ],
        Predicate.isString,
      ),
      " · ",
    ),
  );

/** The effort an agent's profile gives its unpinned candidates, where the details list it. */
const agentDefaultEffort = (
  agent: AgentRouteCard,
  details: ModelsToolDetails,
): string | undefined =>
  agent.effort ??
  findOrUndefined(details.profiles, (profile) => profile.id === agent.profile)?.defaultEffort;

const profileFacts =
  (details: ModelsToolDetails) =>
  (profile: SubagentProfileRouteCard): ReadonlyArray<string> => [
    `${profile.id}: ${eligibleCount(profile.candidates)} · defaults ${profile.defaultContext} · ${profile.defaultWriteIntent} · ${effortFact(profile.defaultEffort, details.parentEffort)}`,
    ...candidateFacts(profile.candidates, inheritedRoute(details, profile.defaultEffort), {
      context: profile.defaultContext,
      writeIntent: profile.defaultWriteIntent,
    }),
  ];

/**
 * The context and write intent a custom agent's line states for its candidates: its own, else its
 * first candidate's, so candidates that share them don't each repeat them.
 */
const agentCandidateDefaults = (agent: AgentRouteCard): Partial<CandidateDefaults> => {
  const [first] = agent.candidates;
  const context = agent.context ?? first?.context;
  const writeIntent = agent.writeIntent ?? first?.writeIntent;
  return {
    ...(context !== undefined && { context }),
    ...(writeIntent !== undefined && { writeIntent }),
  };
};

const agentFacts =
  (details: ModelsToolDetails) =>
  (agent: AgentRouteCard): ReadonlyArray<string> => {
    const defaults = agentCandidateDefaults(agent);
    return [
      `${agent.name}: profile ${agent.profile} · ${eligibleCount(agent.candidates)}${Arr.join(
        Arr.map(
          Arr.filter(
            [
              defaults.context,
              defaults.writeIntent,
              agent.effort && `effort ${agent.effort}`,
              agent.isolation && `isolation ${agent.isolation}`,
              agent.allowedToolCount !== undefined &&
                countLabel(agent.allowedToolCount, "allowed tool"),
              agent.deniedToolCount !== undefined &&
                countLabel(agent.deniedToolCount, "denied tool"),
            ],
            Predicate.isString,
          ),
          (fact) => ` · ${fact}`,
        ),
        "",
      )}`,
      ...candidateFacts(
        agent.candidates,
        inheritedRoute(details, agentDefaultEffort(agent, details)),
        defaults,
      ),
    ];
  };

/**
 * Profile routes as the user reads them: one line per profile and custom agent with the model a
 * launch would take, whether it writes, and where a non-built-in route comes from. Expansion adds
 * eligibility, context, effort, and each candidate among the details.
 */
export const renderProfileRoutesComponent = (
  details: ModelsToolDetails,
  expanded: boolean,
  theme: Theme,
): Component => {
  const agents = details.agents ?? [];
  const rows = [
    ...Arr.map(details.profiles, (profile) => profileRow(profile, details)),
    ...Arr.map(agents, (agent) => agentRow(agent, details)),
  ];
  const lines = (width: number): string[] => {
    const safeWidth = Math.max(1, width);
    const shown =
      expanded || rows.length <= COLLAPSED_AGENT_TEXT_ROWS + 1
        ? rows
        : rows.slice(0, COLLAPSED_AGENT_TEXT_ROWS);
    const hidden = rows.length - shown.length;
    return [
      ...(rows.length === 0 ? [theme.fg("muted", "No profile routes were recorded")] : []),
      ...Arr.flatMap(shown, (row) => routeRowLines(row, safeWidth, theme, expanded)),
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
    ];
  };
  if (!expanded) return renderComponent(lines);
  return expandedRowsBody(theme, lines, [
    `Fallback profile: ${details.fallbackProfile}`,
    ...Arr.flatMap(details.profiles, profileFacts(details)),
    ...Arr.flatMap(agents, agentFacts(details)),
    ...Arr.map(
      details.invalidAgents ?? [],
      (agent) => `Invalid ${agent.scope} agent${agent.name ? `: ${agent.name}` : ""}`,
    ),
  ]);
};

/**
 * A stop or interrupt: its targets grouped by the state they reached, then, expanded, each run's
 * technical facts and the raw failures of targets it couldn't act on.
 */
export const renderCompactResultComponent = (
  details: RunToolDetails,
  expanded: boolean,
  theme: Theme,
  note?: string | false,
): Component => {
  const rows = (width: number): string[] => [
    ...stateGroupLines(details.cards, width, theme, expanded),
    ...(note ? [clipToWidth(theme.fg("dim", note), width)] : []),
  ];
  if (!expanded) return renderComponent(rows);
  // Each failure's message is its issue's detail; the details name the target and code.
  const failures = Arr.map(
    details.actionFailures ?? [],
    (failure) =>
      `${sanitizeTerminalLine(failure.id)}: not ${details.action === "stop" ? "stopped" : "interrupted"}${failure.code ? ` · ${sanitizeTerminalLine(failure.code)}` : ""}`,
  );
  return expandedRowsBody(theme, rows, [...Arr.flatMap(details.cards, cardFactLines), ...failures]);
};
