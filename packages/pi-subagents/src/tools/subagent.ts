// Pi tool execution is a Promise-shaped host boundary.
// @effect-diagnostics effect/asyncFunction:off
import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  getMarkdownTheme,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { withCodePreviewShell } from "pi-code-previews";
import { isProjectTrusted } from "pi-cosmic-core";
import { Type, type Static } from "typebox";
import {
  hostProfileEnvironment,
  liveSubagentStartBoundaries,
  resolveProfileStart,
  type SubagentStartBoundaries,
} from "../boundary/host-profile-resolution.ts";
import { synchronousNow } from "../boundary/native-clock.ts";
import { PROFILE_IDS, type ProfileId } from "../profiles/model.ts";
import { profileCandidateLabel } from "../profiles/resolve.ts";
import { SubagentProfileService, type SubagentProfileServiceShape } from "../profiles/service.ts";
import { InvalidSubagentRequestError, subagentErrorCode } from "../run/errors.ts";
import {
  CLAUDE_CLI_ALIAS_MODELS,
  launchReadyModelLine,
  MAX_DISCOVERY_RESULTS,
  searchSubagentModels,
  type SubagentModelSearchResult,
} from "../run/model-catalog.ts";
import {
  isTerminalRunState,
  type SubagentEffort,
  type SubagentModelView,
  type SubagentRunView,
} from "../run/model.ts";
import { MAX_PARENT_MESSAGE_CHARS, MAX_TARGET_RUNS, MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import {
  SubagentService,
  type SubagentAwaitUntil,
  type SubagentRunObservation,
} from "../run/service.ts";
import { MAX_TASK_CHARS, safeTextPrefix } from "../run/state.ts";
import {
  animatedRunStateGlyph,
  runStateColor,
  runStateGlyph,
  runStateLabel,
} from "../ui/run-state.ts";
import { sanitizeTerminalLine, sanitizeTerminalText } from "../ui/sanitize.ts";

export const SUBAGENT_TOOL_NAMES = [
  "subagent_models",
  "subagent_start",
  "subagent_list",
  "subagent_status",
  "subagent_await",
  "subagent_send",
  "subagent_reply",
  "subagent_lifecycle",
  "subagent_rename",
] as const;

const LIFECYCLE_ACTIONS = ["interrupt", "resume", "stop"] as const;

const StartSpecParameters = Type.Object({
  task: Type.String({ description: "Task for this subagent.", maxLength: MAX_TASK_CHARS }),
  name: Type.Optional(Type.String({ description: "Optional display name." })),
  execution: Type.Optional(
    StringEnum(["foreground", "background"] as const, {
      description:
        "Launch behavior; defaults to background. Foreground blocks subagent_start until the run finishes, pauses, or asks a parent question. Use at most one foreground agent per start call.",
    }),
  ),
  context: Type.Optional(
    StringEnum(["fresh", "fork"] as const, {
      description:
        'Child context. Explicit values override the profile default. Only oracle defaults to "fork"; every other profile defaults to "fresh". Fork requires backend "pi" and a persisted parent leaf.',
    }),
  ),
  profile: Type.Optional(
    StringEnum(PROFILE_IDS, {
      description:
        "Behavior and automatic model-routing profile. Explicit pi/claude-cli backend and model values override routing while retaining profile guidance.",
    }),
  ),
  backend: StringEnum(["auto", "pi", "claude-cli"] as const, {
    description:
      'Execution backend. "auto" deterministically resolves the selected profile (or configured defaultProfile) and cannot combine with model. "pi" and "claude-cli" preserve explicit launch behavior.',
  }),
  writeIntent: StringEnum(["writer", "read-only"] as const, {
    description: "Only one shared-cwd writer may be active.",
  }),
  model: Type.Optional(
    Type.String({
      description:
        'Explicit model override. Invalid with backend "auto". For backend "pi": a canonical provider/model value exactly as listed by subagent_models (omit to inherit the parent model); a bare model ID is accepted only when unique. For backend "claude-cli": a Claude alias or full Claude model ID; Claude defaults to sonnet.',
    }),
  ),
  effort: Type.Optional(
    StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, {
      description:
        "Explicit thinking-effort override. Omit to use the candidate effort, then the profile default effort, then the parent effort. claude-cli supports low through max only; off and minimal are rejected.",
    }),
  ),
});

const RunIdsParameters = Type.Array(Type.String(), {
  description: "Target run IDs.",
  minItems: 1,
  maxItems: MAX_TARGET_RUNS,
});

const MessageParameters = Type.String({
  description: "Message to send to the selected subagent or subagents.",
  maxLength: MAX_PARENT_MESSAGE_CHARS,
});

const ModelsParameters = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "Optional search text; every whitespace-separated term must match, so extra terms narrow the results.",
    }),
  ),
  backend: Type.Optional(
    StringEnum(["pi", "claude-cli"] as const, {
      description: "Optional backend filter for explicit launch-ready model selectors.",
    }),
  ),
  profile: Type.Optional(
    StringEnum(PROFILE_IDS, {
      description: "Optional profile filter; omit to discover every built-in profile route.",
    }),
  ),
});

const StartParameters = Type.Object({
  agents: Type.Array(StartSpecParameters, {
    description: "One to twelve independent subagents to launch.",
    minItems: 1,
    maxItems: MAX_TARGET_RUNS,
  }),
});

const ListParameters = Type.Object({});

const StatusParameters = Type.Object({
  runIds: RunIdsParameters,
});

const AwaitParameters = Type.Object({
  runIds: RunIdsParameters,
  until: StringEnum(["all_finished", "any_finished"] as const, {
    description:
      "Return when all selected runs are finished, or when any selected run is finished. Finished includes completed, failed, and stopped.",
  }),
  timeoutSeconds: Type.Number({
    description: "Await timeout in seconds; use 0 to wait without a timeout.",
    minimum: 0,
    maximum: 3600,
  }),
});

const SendParameters = Type.Object({
  runIds: RunIdsParameters,
  message: MessageParameters,
});

const ReplyParameters = Type.Object({
  runId: Type.String({ description: "Run ID waiting for a parent reply." }),
  message: MessageParameters,
});

const LifecycleParameters = Type.Object({
  action: StringEnum(LIFECYCLE_ACTIONS),
  runIds: RunIdsParameters,
  message: Type.Optional(
    Type.String({
      description: 'Optional continuation guidance; valid only when action="resume".',
      maxLength: MAX_PARENT_MESSAGE_CHARS,
    }),
  ),
});

const RenameParameters = Type.Object({
  runId: Type.String({ description: "Run ID to rename." }),
  name: Type.String({ description: "New display name." }),
});

export type SubagentStartSpec = Static<typeof StartSpecParameters>;
export type SubagentModelsInput = Static<typeof ModelsParameters>;
export type SubagentStartInput = Static<typeof StartParameters>;
export type SubagentListInput = Static<typeof ListParameters>;
export type SubagentStatusInput = Static<typeof StatusParameters>;
export type SubagentAwaitInput = Static<typeof AwaitParameters>;
export type SubagentSendInput = Static<typeof SendParameters>;
export type SubagentReplyInput = Static<typeof ReplyParameters>;
export type SubagentLifecycleInput = Static<typeof LifecycleParameters>;
export type SubagentRenameInput = Static<typeof RenameParameters>;

export type SubagentToolInput =
  | ({ readonly action: "models" } & SubagentModelsInput)
  | ({ readonly action: "start" } & SubagentStartInput)
  | ({ readonly action: "list" } & SubagentListInput)
  | ({ readonly action: "status" } & SubagentStatusInput)
  | ({ readonly action: "await" } & SubagentAwaitInput)
  | ({ readonly action: "send" } & SubagentSendInput)
  | ({ readonly action: "reply" } & SubagentReplyInput)
  | ({ readonly action: SubagentLifecycleInput["action"] } & Omit<SubagentLifecycleInput, "action">)
  | ({ readonly action: "rename" } & SubagentRenameInput);

export interface SubagentStartFailure {
  readonly index: number;
  readonly name?: string;
  readonly message: string;
  /** Machine-actionable failure code (specific validation code or the error tag). */
  readonly code?: string;
}

export interface SubagentActionFailure {
  readonly id: string;
  readonly message: string;
  /** Machine-actionable failure code (specific validation code or the error tag). */
  readonly code?: string;
}

export interface ProfileCandidateDiscovery {
  readonly order: number;
  readonly candidate: string;
  readonly status: "eligible" | "skipped";
  readonly reason: string;
}

export interface SubagentProfileView {
  readonly id: ProfileId;
  readonly description: string;
  readonly defaultContext: "fresh" | "fork";
  readonly defaultEffort?: SubagentEffort | undefined;
  readonly fallback: "fail" | "parent";
  readonly candidates: ReadonlyArray<ProfileCandidateDiscovery>;
}

export interface SubagentToolDetails {
  readonly action: SubagentToolInput["action"];
  readonly runs?: ReadonlyArray<SubagentRunView>;
  readonly startFailures?: ReadonlyArray<SubagentStartFailure>;
  readonly actionFailures?: ReadonlyArray<SubagentActionFailure>;
  readonly models?: ReadonlyArray<SubagentModelView>;
  readonly profiles?: ReadonlyArray<SubagentProfileView>;
  readonly defaultProfile?: ProfileId;
  readonly awaitUntil?: SubagentAwaitUntil;
  readonly timedOut?: boolean;
  readonly attentionRequired?: boolean;
  readonly cancelled?: boolean;
}

export interface SubagentToolRuntime {
  readonly boundaries?: SubagentToolBoundaries | undefined;
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, SubagentService | SubagentProfileService>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

export type SubagentToolBoundaries = SubagentStartBoundaries;

const LIVE_TOOL_BOUNDARIES: SubagentToolBoundaries = liveSubagentStartBoundaries;

const requiredRunId = (
  action: SubagentToolInput["action"],
  runId: string,
): Effect.Effect<string, InvalidSubagentRequestError> =>
  runId.trim()
    ? Effect.succeed(runId.trim())
    : Effect.fail(new InvalidSubagentRequestError({ message: `${action} requires runId.` }));

const requiredTargetIds = (
  action: SubagentToolInput["action"],
  runIds: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, InvalidSubagentRequestError> => {
  const ids = runIds.map((id) => id.trim());
  if (ids.length === 0)
    return Effect.fail(
      new InvalidSubagentRequestError({ message: `${action} requires at least one run ID.` }),
    );
  if (ids.some((id) => !id))
    return Effect.fail(
      new InvalidSubagentRequestError({ message: "Subagent target IDs must be non-empty." }),
    );
  const unique = [...new Set(ids)];
  if (unique.length > MAX_TARGET_RUNS)
    return Effect.fail(
      new InvalidSubagentRequestError({
        message: `Subagent actions accept at most ${MAX_TARGET_RUNS} targets.`,
      }),
    );
  return Effect.succeed(unique);
};

const startSpecs = (
  agents: ReadonlyArray<SubagentStartSpec>,
): Effect.Effect<ReadonlyArray<SubagentStartSpec>, InvalidSubagentRequestError> =>
  Effect.gen(function* () {
    if (agents.length === 0 || agents.length > MAX_TARGET_RUNS)
      return yield* new InvalidSubagentRequestError({
        message: `subagent_start requires between 1 and ${MAX_TARGET_RUNS} agents.`,
      });
    const foregroundCount = agents.filter((agent) => agent.execution === "foreground").length;
    if (foregroundCount > 1)
      return yield* new InvalidSubagentRequestError({
        code: "multiple_foreground_agents",
        message:
          "subagent_start accepts at most one foreground agent per call; launch additional agents in background mode to avoid blocking parent questions.",
      });
    return agents;
  });

const requiredMessage = (
  action: SubagentToolInput["action"],
  message: string,
): Effect.Effect<string, InvalidSubagentRequestError> =>
  message.trim()
    ? Effect.succeed(message.trim())
    : Effect.fail(new InvalidSubagentRequestError({ message: `${action} requires message.` }));

const selectionSourceLabel = (run: SubagentRunView): string => {
  const candidate =
    run.selection.candidateIndex === undefined
      ? ""
      : ` candidate ${run.selection.candidateIndex + 1}`;
  return `${run.selection.source}${candidate}`;
};

const formatRun = (run: SubagentRunView, detailed = false): string => {
  const profile = run.profile ? ` · profile=${run.profile}` : "";
  const header = `${run.id} ${run.name} · ${run.state} · ${run.writeIntent}${profile} · ${run.backend}/${run.model}:${run.effort}`;
  if (!detailed) return header;
  const field = (label: string, value: string): string => `  ${label.padEnd(10)} ${value}`;
  return [
    "Subagent status",
    field("Name", run.name),
    field("ID", run.id),
    field("State", run.state),
    run.profile ? field("Profile", run.profile) : undefined,
    field("Model", `${run.backend}/${run.model} · ${run.effort}`),
    field("Selection", selectionSourceLabel(run)),
    field("Reason", run.selection.reason),
    ...run.selection.skippedCandidates.map((candidate) =>
      field(
        "Skipped",
        `${candidate.candidateIndex === undefined ? "fallback" : `candidate ${candidate.candidateIndex + 1}`} [${candidate.code}]: ${candidate.reason}`,
      ),
    ),
    run.selection.warning ? field("Policy", run.selection.warning) : undefined,
    field("Mode", `${run.execution} · ${run.context}`),
    field("Intent", run.writeIntent),
    field("Capabilities", `${run.capabilities.join(", ") || "none"}; stop/await always available`),
    run.pid ? field("Process", `pid ${run.pid}`) : undefined,
    field("Usage", `${run.usage.totalTokens} tokens · $${run.usage.cost.toFixed(4)}`),
    run.currentTool ? field("Tool", run.currentTool) : undefined,
    run.progress ? field("Progress", run.progress) : undefined,
    run.warning ? field("Warning", run.warning) : undefined,
    run.question ? field("Question", run.question.message) : undefined,
    run.error ? field("Error", run.error) : undefined,
    run.finalText
      ? `\nFinal report\n${run.finalText}`
      : run.state === "completed"
        ? "\nFinal report\nCompleted without a final report."
        : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
};

interface DetailedRunsFormat {
  readonly text: string;
  readonly fullyRenderedIds: ReadonlySet<string>;
}

const formatDetailedRuns = (
  runs: ReadonlyArray<SubagentRunView>,
  prefix = "",
): DetailedRunsFormat => {
  if (runs.length === 0)
    return { text: prefix || "No subagent runs.", fullyRenderedIds: new Set() };
  const separatorLength = Math.max(0, runs.length - 1) * 2;
  const available = Math.max(0, MAX_TOOL_OUTPUT_CHARS - prefix.length - separatorLength);
  const perRun = Math.max(256, Math.floor(available / runs.length));
  const fullyRenderedIds = new Set<string>();
  const formatted = runs.map((run) => {
    const value = formatRun(run, true);
    if (value.length <= perRun) {
      fullyRenderedIds.add(run.id);
      return value;
    }
    const marker = "\n… [run output truncated]";
    return `${safeTextPrefix(value, Math.max(0, perRun - marker.length))}${marker}`;
  });
  const output = `${prefix}${formatted.join("\n\n")}`;
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return { text: output, fullyRenderedIds };
  return {
    text: `${safeTextPrefix(output, MAX_TOOL_OUTPUT_CHARS - 1)}…`,
    fullyRenderedIds: new Set(),
  };
};

const formatStartFailures = (failures: ReadonlyArray<SubagentStartFailure>): string =>
  failures.length === 0
    ? ""
    : [
        `Failed starts (${failures.length})`,
        ...failures.map((failure) => {
          const target = failure.name ? ` ${sanitizeTerminalLine(failure.name)}` : "";
          const message = safeTextPrefix(sanitizeTerminalLine(failure.message), 320);
          const code = failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : "";
          return `  #${failure.index + 1}${target}${code}: ${message}`;
        }),
      ].join("\n");

const formatStartResult = (
  runs: ReadonlyArray<SubagentRunView>,
  failures: ReadonlyArray<SubagentStartFailure>,
): string => {
  const failureText = formatStartFailures(failures);
  return formatDetailedRuns(
    runs,
    failureText ? `${failureText}${runs.length > 0 ? "\n\n" : ""}` : "",
  ).text;
};

const formatActionFailures = (failures: ReadonlyArray<SubagentActionFailure>): string =>
  failures.length === 0
    ? ""
    : [
        `Failed targets (${failures.length})`,
        ...failures.map((failure) => {
          const code = failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : "";
          return `  ${sanitizeTerminalLine(failure.id)}${code}: ${safeTextPrefix(sanitizeTerminalLine(failure.message), 320)}`;
        }),
      ].join("\n");

const joinBoundedToolText = (parts: ReadonlyArray<string>): string => {
  const text = parts.filter(Boolean).join("\n\n");
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  const marker = "\n… [tool output truncated]";
  return `${safeTextPrefix(text, MAX_TOOL_OUTPUT_CHARS - marker.length)}${marker}`;
};

const renderedCompletionReceipts = (
  observations: ReadonlyArray<SubagentRunObservation>,
  fullyRenderedIds: ReadonlySet<string>,
) =>
  observations.flatMap((observation) =>
    observation.completionReceipt && fullyRenderedIds.has(observation.run.id)
      ? [observation.completionReceipt]
      : [],
  );

function availableModels(
  input: SubagentModelsInput,
  ctx: ExtensionContext,
  profiles: SubagentProfileServiceShape,
): SubagentModelSearchResult {
  const piModels: ReadonlyArray<SubagentModelView> = ctx.modelRegistry
    .getAvailable()
    .map((model) => ({
      backend: "pi" as const,
      id: `${model.provider}/${model.id}`,
      name: model.name,
      reasoning: model.reasoning,
    }));
  const selectorCatalog = isProjectTrusted(ctx)
    ? [...piModels, ...CLAUDE_CLI_ALIAS_MODELS]
    : piModels;
  const policyAnnotated = selectorCatalog.flatMap((model) => {
    const policy = profiles.policyFor(model.backend, model.id);
    if (policy === "denied") return [];
    return [{ ...model, ...(policy === "discouraged" ? { policy } : {}) }];
  });
  return searchSubagentModels(policyAnnotated, input.query, input.backend);
}

const profileDiscovery = (
  input: SubagentModelsInput,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  profiles: SubagentProfileServiceShape,
): ReadonlyArray<SubagentProfileView> => {
  const ids = input.profile ? [input.profile] : PROFILE_IDS;
  const environment = hostProfileEnvironment(pi, ctx);
  return ids.flatMap((id) => {
    const definition = profiles.definition(id);
    if (!definition) return [];
    const route = profiles.config.profiles[definition.id];
    const resolution = profiles.resolve(definition.id, environment);
    const attempts = resolution.kind === "resolved" ? resolution.attempts : [];
    const skipped = resolution.skippedCandidates;
    const candidates: ProfileCandidateDiscovery[] = route.candidates.map((candidate, index) => {
      const attempt = attempts.find((value) => value.candidateIndex === index);
      const omitted = skipped.find((value) => value.candidateIndex === index);
      return {
        order: index + 1,
        candidate: profileCandidateLabel(candidate),
        status: attempt ? "eligible" : "skipped",
        reason: attempt?.reason ?? omitted?.reason ?? "Candidate was not eligible.",
      };
    });
    if (route.fallback === "parent") {
      const attempt = attempts.find((value) => value.source === "profile-parent-fallback");
      const omitted = skipped.find(
        (value) => value.candidateIndex === undefined && value.candidate === "parent fallback",
      );
      candidates.push({
        order: route.candidates.length + 1,
        candidate: "parent fallback",
        status: attempt ? "eligible" : "skipped",
        reason: attempt?.reason ?? omitted?.reason ?? "Parent fallback was not eligible.",
      });
    }
    return [
      {
        id: definition.id,
        description: definition.description,
        defaultContext: definition.defaultContext,
        ...(definition.defaultEffort ? { defaultEffort: definition.defaultEffort } : {}),
        fallback: route.fallback,
        candidates,
      },
    ];
  });
};

const formatProfileDiscovery = (
  profiles: ReadonlyArray<SubagentProfileView>,
  defaultProfile: ProfileId,
): string =>
  [
    "Profiles (use backend=auto; explicit backend/model overrides routing but retains guidance)",
    `Configured default profile: ${defaultProfile}`,
    ...profiles.flatMap((profile) => [
      `${profile.id} · context=${profile.defaultContext} · effort=${profile.defaultEffort ?? "inherit"} · fallback=${profile.fallback} · ${profile.description}`,
      ...(profile.candidates.length > 0
        ? profile.candidates.map(
            (candidate) =>
              `  ${candidate.order}. ${candidate.candidate} · ${candidate.status} · ${candidate.reason}`,
          )
        : ["  no configured candidates"]),
    ]),
  ].join("\n");

const awaitProgressHeader = (
  runs: ReadonlyArray<SubagentRunView>,
  until: SubagentAwaitUntil,
): string => {
  const finished = runs.filter((run) => isTerminalRunState(run.state)).length;
  const condition = until === "all_finished" ? "Waiting for all agents" : "Waiting for first agent";
  const unfinishedStates = [
    "starting",
    "running",
    "waiting_for_parent",
    "paused",
    "stopping",
  ] as const;
  const activeSummary = unfinishedStates
    .flatMap((state) => {
      const count = runs.filter((run) => run.state === state).length;
      return count > 0 ? [`${count} ${runStateLabel(state)}`] : [];
    })
    .join(" · ");
  if (finished === runs.length)
    return `${runs.length} agent${runs.length === 1 ? "" : "s"} finished`;
  return `${condition} · ${finished} of ${runs.length} finished${activeSummary ? ` · ${activeSummary}` : ""}`;
};

const awaitRunStatus = (run: SubagentRunView): string =>
  sanitizeTerminalLine(
    `${runStateLabel(run.state)}${run.currentTool ? ` (${run.currentTool})` : ""}`,
  );

const formatAwaitProgress = (
  runs: ReadonlyArray<SubagentRunView>,
  until: SubagentAwaitUntil,
): string =>
  [
    awaitProgressHeader(runs, until),
    ...runs.map(
      (run) =>
        `${runStateGlyph(run.state)} ${sanitizeTerminalLine(run.name)} (${sanitizeTerminalLine(run.id)}) · ${awaitRunStatus(run)}`,
    ),
  ].join("\n");

const awaitHeaderColor = (
  runs: ReadonlyArray<SubagentRunView>,
): "warning" | "success" | "error" => {
  if (runs.some((run) => run.state === "failed")) return "error";
  return runs.length > 0 && runs.every((run) => isTerminalRunState(run.state))
    ? "success"
    : "warning";
};

const padVisible = (value: string, width: number): string =>
  `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;

class AwaitProgressComponent implements Component {
  private readonly runs: ReadonlyArray<SubagentRunView>;
  private readonly until: SubagentAwaitUntil;
  private readonly theme: Theme;

  constructor(runs: ReadonlyArray<SubagentRunView>, until: SubagentAwaitUntil, theme: Theme) {
    this.runs = runs;
    this.until = until;
    this.theme = theme;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const frame = Math.floor(synchronousNow() / 160);
    return [
      truncateToWidth(
        this.theme.fg(awaitHeaderColor(this.runs), awaitProgressHeader(this.runs, this.until)),
        safeWidth,
      ),
      ...renderResponsiveRunRows(this.runs, safeWidth, this.theme, {
        frame,
        status: awaitRunStatus,
      }),
    ];
  }

  invalidate(): void {
    // Rendering is derived from the current clock frame.
  }
}

const effortColor = (
  effort: SubagentEffort,
):
  | "thinkingOff"
  | "thinkingMinimal"
  | "thinkingLow"
  | "thinkingMedium"
  | "thinkingHigh"
  | "thinkingXhigh"
  | "thinkingMax" => {
  switch (effort) {
    case "off":
      return "thinkingOff";
    case "minimal":
      return "thinkingMinimal";
    case "low":
      return "thinkingLow";
    case "medium":
      return "thinkingMedium";
    case "high":
      return "thinkingHigh";
    case "xhigh":
      return "thinkingXhigh";
    case "max":
      return "thinkingMax";
  }
};

interface RunReportSection {
  readonly name: string;
  readonly kind: "report" | "failure";
  readonly text: string;
}

const expandedRunReportSections = (
  runs: ReadonlyArray<SubagentRunView>,
): ReadonlyArray<RunReportSection> => {
  const candidates = runs.flatMap((run): ReadonlyArray<RunReportSection> => {
    const name = sanitizeTerminalLine(run.name);
    if (run.finalText) return [{ name, kind: "report", text: sanitizeTerminalText(run.finalText) }];
    if (run.error) return [{ name, kind: "failure", text: sanitizeTerminalText(run.error) }];
    return [];
  });
  if (candidates.length === 0) return [];
  const headingBudget = candidates.reduce((total, section) => total + section.name.length + 24, 0);
  const perSection = Math.max(
    256,
    Math.floor((MAX_TOOL_OUTPUT_CHARS - headingBudget) / candidates.length),
  );
  return candidates.map((section) => {
    if (section.text.length <= perSection) return section;
    const marker = "\n… [report truncated]";
    return {
      ...section,
      text: `${safeTextPrefix(section.text, perSection - marker.length)}${marker}`,
    };
  });
};

const reportAffordance = (
  sections: ReadonlyArray<RunReportSection>,
  expanded: boolean,
  theme: Theme,
): string => {
  const reportCount = sections.filter((section) => section.kind === "report").length;
  const failureCount = sections.length - reportCount;
  const label =
    failureCount === 0
      ? `final report${reportCount === 1 ? "" : "s"}`
      : reportCount === 0
        ? `failure detail${failureCount === 1 ? "" : "s"}`
        : "reports and failures";
  return theme.fg("dim", `${expanded ? "▾" : "▸"} ${label}${expanded ? "" : " · expand to view"}`);
};

const renderStartFailures = (
  failures: ReadonlyArray<SubagentStartFailure>,
  expanded: boolean,
  theme: Theme,
): string =>
  failures
    .map((failure) => {
      const name = sanitizeTerminalLine(failure.name ?? `start #${failure.index + 1}`);
      const summary = `${theme.fg("error", `× ${name}`)} · ${theme.fg("error", "failed to start")}`;
      if (!expanded) return summary;
      return `${summary}\n${theme.fg("dim", safeTextPrefix(sanitizeTerminalLine(failure.message), 320))}`;
    })
    .join("\n");

export interface OutcomeBanner {
  readonly color: "warning" | "success" | "error" | "accent";
  readonly text: string;
}

interface ResponsiveRunRowOptions {
  readonly frame?: number;
  readonly status?: (run: SubagentRunView) => string;
}

const renderResponsiveRunRows = (
  runs: ReadonlyArray<SubagentRunView>,
  width: number,
  theme: Theme,
  options: ResponsiveRunRowOptions = {},
): string[] => {
  const safeWidth = Math.max(1, width);
  const names = runs.map((run) => {
    const glyph =
      options.frame === undefined
        ? runStateGlyph(run.state)
        : animatedRunStateGlyph(run.state, options.frame);
    return `${glyph} ${sanitizeTerminalLine(run.name)}`;
  });
  const efforts = runs.map((run) => sanitizeTerminalLine(run.effort));
  const states = runs.map((run) =>
    sanitizeTerminalLine(options.status?.(run) ?? runStateLabel(run.state)),
  );
  const nameWidth = names.reduce((max, name) => Math.max(max, visibleWidth(name)), 0);
  const effortWidth = efforts.reduce((max, effort) => Math.max(max, visibleWidth(effort)), 0);
  const stateWidth = states.reduce((max, state) => Math.max(max, visibleWidth(state)), 0);
  const modelWidth = safeWidth - nameWidth - effortWidth - stateWidth - 9;
  if (safeWidth >= 64 && modelWidth >= 8)
    return runs.map((run, index) => {
      const name = theme.fg(runStateColor(run.state), names[index] ?? "");
      const model = truncateToWidth(
        sanitizeTerminalLine(`${run.profile ? `[${run.profile}] ` : ""}${run.model}`),
        modelWidth,
      );
      const effort = efforts[index] ?? "";
      const state = theme.fg(runStateColor(run.state), states[index] ?? "");
      return `${padVisible(name, nameWidth)} · ${padVisible(theme.fg("toolOutput", model), modelWidth)} · ${padVisible(theme.fg(effortColor(run.effort), effort), effortWidth)} · ${padVisible(state, stateWidth)}`;
    });
  return runs.flatMap((run, index) => {
    const color = runStateColor(run.state);
    const name = theme.fg(color, names[index] ?? "");
    const state = theme.fg(color, states[index] ?? "");
    const effort = efforts[index] ?? "";
    const modelWidth = Math.max(1, safeWidth - visibleWidth(effort) - 3);
    const model = theme.fg(
      "toolOutput",
      truncateToWidth(
        sanitizeTerminalLine(`${run.profile ? `[${run.profile}] ` : ""}${run.model}`),
        modelWidth,
      ),
    );
    return [
      truncateToWidth(name, safeWidth),
      truncateToWidth(`${model} · ${theme.fg(effortColor(run.effort), effort)}`, safeWidth),
      truncateToWidth(state, safeWidth),
    ];
  });
};

class RunOverviewComponent implements Component {
  private readonly runs: ReadonlyArray<SubagentRunView>;
  private readonly failures: ReadonlyArray<SubagentStartFailure>;
  private readonly expanded: boolean;
  private readonly theme: Theme;
  private readonly reportSections: ReadonlyArray<RunReportSection>;
  private readonly banner: OutcomeBanner | undefined;

  constructor(
    runs: ReadonlyArray<SubagentRunView>,
    failures: ReadonlyArray<SubagentStartFailure>,
    expanded: boolean,
    theme: Theme,
    reportSections: ReadonlyArray<RunReportSection>,
    banner?: OutcomeBanner,
  ) {
    this.runs = runs;
    this.failures = failures;
    this.expanded = expanded;
    this.theme = theme;
    this.reportSections = reportSections;
    this.banner = banner;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    return [
      ...(this.banner
        ? [truncateToWidth(this.theme.fg(this.banner.color, this.banner.text), safeWidth)]
        : []),
      ...renderResponsiveRunRows(this.runs, safeWidth, this.theme),
      ...(this.expanded
        ? this.runs.flatMap((run) => {
            const profile = run.profile ? `${run.profile} · ` : "";
            const summary = `${profile}${selectionSourceLabel(run)} · ${run.selection.reason}`;
            return [
              truncateToWidth(this.theme.fg("dim", summary), safeWidth),
              ...run.selection.skippedCandidates.map((candidate) =>
                truncateToWidth(
                  this.theme.fg(
                    "dim",
                    `  skipped ${candidate.candidate} [${candidate.code}] · ${candidate.reason}`,
                  ),
                  safeWidth,
                ),
              ),
              ...(run.selection.warning
                ? [
                    truncateToWidth(
                      this.theme.fg("warning", `  ${run.selection.warning}`),
                      safeWidth,
                    ),
                  ]
                : []),
            ];
          })
        : []),
      ...renderStartFailures(this.failures, this.expanded, this.theme)
        .split("\n")
        .filter(Boolean)
        .map((line) => truncateToWidth(line, safeWidth)),
      ...(this.reportSections.length > 0
        ? [
            truncateToWidth(
              reportAffordance(this.reportSections, this.expanded, this.theme),
              safeWidth,
            ),
          ]
        : []),
    ];
  }

  invalidate(): void {
    // Rendering is a pure projection of immutable result details.
  }
}

/** Partial await rendering: the animated in-progress fleet card. */
export const renderAwaitProgressComponent = (
  runs: ReadonlyArray<SubagentRunView>,
  until: SubagentAwaitUntil,
  theme: Theme,
): Component => new AwaitProgressComponent(runs, until, theme);

/** Collapsed start/await rendering: run summaries, launch failures, and the report affordance. */
export const renderStartAwaitOverviewComponent = (
  runs: ReadonlyArray<SubagentRunView>,
  theme: Theme,
  failures: ReadonlyArray<SubagentStartFailure> = [],
  banner?: OutcomeBanner,
): Component =>
  new RunOverviewComponent(runs, failures, false, theme, expandedRunReportSections(runs), banner);

export const renderExpandedStartAwaitResult = (
  runs: ReadonlyArray<SubagentRunView>,
  theme: Theme,
  failures: ReadonlyArray<SubagentStartFailure> = [],
  banner?: OutcomeBanner,
): Component => {
  const container = new Container();
  const sections = expandedRunReportSections(runs);
  container.addChild(new RunOverviewComponent(runs, failures, true, theme, sections, banner));
  if (sections.length === 0) return container;
  for (const section of sections) {
    container.addChild(new Spacer(1));
    const heading = section.kind === "report" ? "Final report" : "Failure";
    container.addChild(
      new Text(
        theme.fg(section.kind === "report" ? "accent" : "error", `${heading} — ${section.name}`),
        0,
        0,
      ),
    );
    if (section.kind === "report")
      container.addChild(
        new Markdown(section.text, 2, 0, getMarkdownTheme(), {
          color: (text) => theme.fg("toolOutput", text),
        }),
      );
    else container.addChild(new Text(theme.fg("error", section.text), 2, 0));
  }
  return container;
};

export const awaitResultBanner = (details: SubagentToolDetails): OutcomeBanner | undefined => {
  const runs = details.runs ?? [];
  const unfinished = runs.filter((run) => !isTerminalRunState(run.state));
  if (details.cancelled)
    return {
      color: "warning",
      text:
        runs.length === 0
          ? "Await cancelled · subagents continue running"
          : `Await cancelled · ${unfinished.length} agent${unfinished.length === 1 ? " continues" : "s continue"} running`,
    };
  if (details.timedOut)
    return {
      color: "warning",
      text: `Await timed out · ${unfinished.length} agent${unfinished.length === 1 ? "" : "s"} still running`,
    };
  if (details.attentionRequired) {
    const waiting = runs.filter((run) => run.state === "waiting_for_parent").length;
    return {
      color: "warning",
      text: `Parent reply required · ${waiting} agent${waiting === 1 ? " is" : "s are"} waiting`,
    };
  }
  if (details.awaitUntil !== "any_finished") return undefined;
  const first = runs
    .filter((run) => isTerminalRunState(run.state))
    .sort((left, right) => (left.endedAt ?? Infinity) - (right.endedAt ?? Infinity))[0];
  if (!first) return undefined;
  const name = sanitizeTerminalLine(first.name);
  const outcome = runStateLabel(first.state);
  return {
    color: first.state === "failed" ? "error" : "accent",
    text: `${name} ${outcome} first${unfinished.length > 0 ? ` · ${unfinished.length} agent${unfinished.length === 1 ? " continues" : "s continue"} running` : ""}`,
  };
};

const managementAcknowledgement = (
  action: Exclude<SubagentToolInput["action"], "models" | "start">,
  runs: ReadonlyArray<SubagentRunView>,
): string => {
  const ids = runs.map((run) => run.id).join(", ");
  if (runs.length === 0) return "";
  switch (action) {
    case "send":
      return `Guidance delivered to ${runs.length} subagent${runs.length === 1 ? "" : "s"}: ${ids}.`;
    case "reply":
      return `Reply delivered to ${ids}.`;
    case "interrupt":
      return `Paused ${ids}.`;
    case "resume":
      return `Resumed ${ids}.`;
    case "rename":
      return `Renamed ${ids}.`;
    case "stop":
      return `Stopped ${ids}.`;
    default:
      return runs.map((run) => formatRun(run, true)).join("\n\n");
  }
};

const executeSubagentAction = async (
  pi: ExtensionAPI,
  runtime: SubagentToolRuntime,
  input: SubagentToolInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  ctx: ExtensionContext,
  boundaries: SubagentToolBoundaries = runtime.boundaries ?? LIVE_TOOL_BOUNDARIES,
): Promise<AgentToolResult<unknown>> => {
  if (input.action === "models") {
    const discovery = Effect.gen(function* () {
      const profileService = yield* SubagentProfileService;
      const search = availableModels(input, ctx, profileService);
      const models = search.models;
      const profiles = profileDiscovery(input, pi, ctx, profileService);
      const selectorText =
        models.length > 0
          ? [
              "Accepted explicit selectors (denied models are hidden; discouraged models require explicit selection; Claude readiness is checked at launch)",
              ...models.map(launchReadyModelLine),
              ...(search.truncated
                ? [
                    `Showing the first ${MAX_DISCOVERY_RESULTS} matching selectors; narrow query or backend to search further.`,
                  ]
                : []),
            ].join("\n")
          : "No matching explicit model selectors.";
      return {
        content: [
          {
            type: "text" as const,
            text: joinBoundedToolText([
              formatProfileDiscovery(profiles, profileService.config.defaultProfile),
              selectorText,
            ]),
          },
        ],
        details: {
          action: input.action,
          models,
          profiles,
          defaultProfile: profileService.config.defaultProfile,
        },
      };
    });
    return runtime.run(discovery, signal);
  }

  let latestAwaitRuns: ReadonlyArray<SubagentRunView> = [];
  const requestedAwaitUntil = input.action === "await" ? input.until : undefined;
  const effect = Effect.gen(function* () {
    const service = yield* SubagentService;
    const consumeCompletions = (
      observations: ReadonlyArray<SubagentRunObservation>,
      fullyRenderedIds: ReadonlySet<string>,
    ) => service.consumeCompletions(renderedCompletionReceipts(observations, fullyRenderedIds));
    const finishObservations = (
      observations: ReadonlyArray<SubagentRunObservation>,
      timedOut: boolean,
    ) =>
      Effect.gen(function* () {
        const runs = observations.map((observation) => observation.run);
        const waiting = runs.filter(
          (run) => run.state === "waiting_for_parent" && run.question !== undefined,
        );
        const attentionRequired = waiting.length > 0;
        const attentionText = attentionRequired
          ? [
              "Await paused because a parent reply is required; other subagents continue running.",
              ...waiting.map(
                (run) =>
                  `Reply with subagent_reply({ runId: "${run.id}", message: "..." }), then call subagent_await again.`,
              ),
              "",
            ].join("\n")
          : "";
        const formatted = formatDetailedRuns(
          runs,
          timedOut ? "Await timed out; subagents continue running.\n\n" : attentionText,
        );
        yield* consumeCompletions(observations, formatted.fullyRenderedIds);
        return { runs, timedOut, attentionRequired, text: formatted.text };
      });
    const finishStatus = (ids: ReadonlyArray<string>, timedOut: boolean, attentionAware = false) =>
      service.withStatusObservations(ids, ({ observations, missingIds }) => {
        const actionFailures = missingIds.map(
          (id): SubagentActionFailure => ({
            id,
            code: "SubagentNotFoundError",
            message: `Subagent run not found: ${id}. Use subagent_list to refresh active run IDs.`,
          }),
        );
        if (attentionAware)
          return finishObservations(observations, timedOut).pipe(
            Effect.map((result) => ({ ...result, actionFailures })),
          );
        return Effect.gen(function* () {
          const runs = observations.map((observation) => observation.run);
          const failureText = formatActionFailures(actionFailures);
          const formatted = formatDetailedRuns(
            runs,
            failureText ? `${failureText}${runs.length > 0 ? "\n\n" : ""}` : "",
          );
          yield* consumeCompletions(observations, formatted.fullyRenderedIds);
          return {
            runs,
            timedOut,
            attentionRequired: false,
            text: formatted.text,
            actionFailures,
          };
        });
      });

    switch (input.action) {
      case "start": {
        const specs = yield* startSpecs(input.agents);
        let launchedRuns: ReadonlyArray<SubagentRunView> = [];
        const startOne = (spec: SubagentStartSpec) =>
          Effect.gen(function* () {
            const request = yield* resolveProfileStart(pi, spec, ctx, boundaries);
            const started = yield* service.start(request);
            launchedRuns = [...launchedRuns, started];
            yield* Effect.sync(() =>
              onUpdate?.({
                content: [
                  {
                    type: "text",
                    text: `Started ${launchedRuns.length} of ${specs.length} subagent${specs.length === 1 ? "" : "s"}${request.execution === "foreground" ? "; waiting for the foreground run" : ""}.`,
                  },
                ],
                details: { action: "start", runs: launchedRuns },
              }),
            ).pipe(
              Effect.catchDefect(() => Effect.void),
              Effect.asVoid,
            );
            return request.execution === "foreground"
              ? yield* service.waitForForeground(started.id)
              : started;
          });
        const outcomes = yield* Effect.forEach(
          specs,
          (spec, index) =>
            startOne(spec).pipe(
              Effect.match({
                onFailure: (error) => ({
                  failure: {
                    index,
                    ...(spec.name?.trim() ? { name: spec.name.trim() } : {}),
                    message: error.message,
                    code: subagentErrorCode(error),
                  } satisfies SubagentStartFailure,
                }),
                onSuccess: (run) => ({ run }),
              }),
            ),
          { concurrency: MAX_TARGET_RUNS },
        );
        return {
          runs: outcomes.flatMap((outcome) => ("run" in outcome ? [outcome.run] : [])),
          startFailures: outcomes.flatMap((outcome) =>
            "failure" in outcome ? [outcome.failure] : [],
          ),
          timedOut: false,
        };
      }
      case "list":
        return { runs: yield* service.list, timedOut: false };
      case "status":
        return yield* finishStatus(yield* requiredTargetIds(input.action, input.runIds), false);
      case "await": {
        const ids = yield* requiredTargetIds(input.action, input.runIds);
        const until = input.until;
        let lastUpdate = "";
        const updateAwait = (runs: ReadonlyArray<SubagentRunView>) => {
          latestAwaitRuns = runs;
          const text = formatAwaitProgress(runs, until);
          if (text === lastUpdate) return;
          lastUpdate = text;
          onUpdate?.({
            content: [{ type: "text", text }],
            details: { action: "await", runs, awaitUntil: until },
          });
        };
        const waiting = service.withAwaitTerminalObservations(
          ids,
          until,
          updateAwait,
          (observations) => finishObservations(observations, false),
        );
        if (input.timeoutSeconds === 0) return yield* waiting;
        const outcome = yield* waiting.pipe(
          Effect.timeoutOption(`${input.timeoutSeconds} seconds`),
        );
        if (Option.isSome(outcome)) return outcome.value;
        return yield* finishStatus(ids, true, true);
      }
      case "send": {
        const ids = yield* requiredTargetIds(input.action, input.runIds);
        const message = yield* requiredMessage(input.action, input.message);
        const outcomes = yield* Effect.forEach(
          ids,
          (id) =>
            service.send(id, message).pipe(
              Effect.match({
                onFailure: (error) => ({
                  failure: {
                    id,
                    message: error.message,
                    code: subagentErrorCode(error),
                  } satisfies SubagentActionFailure,
                }),
                onSuccess: (run) => ({ run }),
              }),
            ),
          { concurrency: 8 },
        );
        return {
          runs: outcomes.flatMap((outcome) => ("run" in outcome ? [outcome.run] : [])),
          actionFailures: outcomes.flatMap((outcome) =>
            "failure" in outcome ? [outcome.failure] : [],
          ),
          timedOut: false,
        };
      }
      case "reply": {
        const id = yield* requiredRunId(input.action, input.runId);
        const message = yield* requiredMessage(input.action, input.message);
        const outcome = yield* service.reply(id, message).pipe(
          Effect.match({
            onFailure: (error) => ({
              failure: {
                id,
                message: error.message,
                code: subagentErrorCode(error),
              } satisfies SubagentActionFailure,
            }),
            onSuccess: (run) => ({ run }),
          }),
        );
        return "run" in outcome
          ? { runs: [outcome.run], timedOut: false }
          : { runs: [], actionFailures: [outcome.failure], timedOut: false };
      }
      case "interrupt":
      case "resume":
      case "stop": {
        if (input.action !== "resume" && input.message !== undefined)
          return yield* new InvalidSubagentRequestError({
            message: 'subagent_lifecycle message is valid only when action="resume".',
          });
        const ids = yield* requiredTargetIds(input.action, input.runIds);
        const outcomes = yield* Effect.forEach(
          ids,
          (id) => {
            const operation = (() => {
              switch (input.action) {
                case "interrupt":
                  return service.interrupt(id);
                case "resume":
                  return service.resume(id, input.message);
                case "stop":
                  return service.stop(id);
              }
            })();
            return operation.pipe(
              Effect.match({
                onFailure: (error) => ({
                  failure: {
                    id,
                    message: error.message,
                    code: subagentErrorCode(error),
                  } satisfies SubagentActionFailure,
                }),
                onSuccess: (run) => ({ run }),
              }),
            );
          },
          { concurrency: 8 },
        );
        return {
          runs: outcomes.flatMap((outcome) => ("run" in outcome ? [outcome.run] : [])),
          actionFailures: outcomes.flatMap((outcome) =>
            "failure" in outcome ? [outcome.failure] : [],
          ),
          timedOut: false,
        };
      }
      case "rename": {
        const id = yield* requiredRunId(input.action, input.runId);
        const outcome = yield* service.rename(id, input.name.trim()).pipe(
          Effect.match({
            onFailure: (error) => ({
              failure: {
                id,
                message: error.message,
                code: subagentErrorCode(error),
              } satisfies SubagentActionFailure,
            }),
            onSuccess: (run) => ({ run }),
          }),
        );
        return "run" in outcome
          ? { runs: [outcome.run], timedOut: false }
          : { runs: [], actionFailures: [outcome.failure], timedOut: false };
      }
    }
  });

  const cancelAwait = () => {
    if (input.action !== "await" || !requestedAwaitUntil) return;
    try {
      onUpdate?.({
        content: [{ type: "text", text: "Await cancelled; subagents continue running." }],
        details: {
          action: "await",
          runs: latestAwaitRuns,
          awaitUntil: requestedAwaitUntil,
          cancelled: true,
        },
      });
    } catch {
      // Cancellation rendering is best effort and cannot own the waiter lifecycle.
    }
  };
  if (signal?.aborted) cancelAwait();
  else signal?.addEventListener("abort", cancelAwait, { once: true });

  let executionResult: {
    readonly runs: ReadonlyArray<SubagentRunView>;
    readonly startFailures?: ReadonlyArray<SubagentStartFailure>;
    readonly actionFailures?: ReadonlyArray<SubagentActionFailure>;
    readonly timedOut: boolean;
    readonly attentionRequired?: boolean;
    readonly text?: string;
  };
  try {
    executionResult = await runtime.run(effect, signal);
  } finally {
    signal?.removeEventListener("abort", cancelAwait);
  }

  const { runs, timedOut, attentionRequired, text: formattedText } = executionResult;
  const startFailures = executionResult.startFailures ?? [];
  const actionFailures = executionResult.actionFailures ?? [];
  const managementAction =
    input.action === "send" ||
    input.action === "reply" ||
    input.action === "interrupt" ||
    input.action === "resume" ||
    input.action === "stop" ||
    input.action === "rename";
  const details: SubagentToolDetails =
    input.action === "start"
      ? {
          action: input.action,
          runs,
          ...(startFailures.length > 0 ? { startFailures } : {}),
        }
      : input.action === "await"
        ? {
            action: input.action,
            runs,
            awaitUntil: input.until,
            ...(timedOut ? { timedOut: true } : {}),
            ...(attentionRequired ? { attentionRequired: true } : {}),
          }
        : {
            action: input.action,
            ...(managementAction || actionFailures.length > 0 ? { runs } : {}),
            ...(actionFailures.length > 0 ? { actionFailures } : {}),
            ...(timedOut ? { timedOut: true } : {}),
          };
  const text =
    input.action === "start"
      ? formatStartResult(runs, startFailures)
      : actionFailures.length > 0
        ? input.action === "status"
          ? (formattedText ?? formatDetailedRuns(runs).text)
          : joinBoundedToolText([
              managementAcknowledgement(input.action, runs),
              formatActionFailures(actionFailures),
            ])
        : runs.length === 0
          ? "No subagent runs."
          : input.action === "list"
            ? runs.map((run) => formatRun(run)).join("\n")
            : input.action === "status"
              ? (formattedText ?? formatDetailedRuns(runs).text)
              : input.action === "await"
                ? (formattedText ?? formatDetailedRuns(runs).text)
                : managementAcknowledgement(input.action, runs);
  return { content: [{ type: "text", text }], details };
};

const renderSubagentCall = (name: string, target: string, theme: Theme): Component => {
  const clippedTarget = safeTextPrefix(sanitizeTerminalLine(target), 160);
  return new Text(
    `${theme.fg("toolTitle", theme.bold(name))}${clippedTarget ? ` ${theme.fg("dim", clippedTarget)}` : ""}`,
    0,
    0,
  );
};

const renderSubagentResult = (
  result: {
    readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    readonly details?: unknown;
  },
  isPartial: boolean,
  expanded: boolean,
  theme: Theme,
): Component => {
  const details = result.details as SubagentToolDetails | undefined;
  if (isPartial && details?.action === "await" && details.runs && details.awaitUntil) {
    if (details.cancelled)
      return new RunOverviewComponent(
        details.runs,
        [],
        false,
        theme,
        [],
        awaitResultBanner(details),
      );
    return renderAwaitProgressComponent(details.runs, details.awaitUntil, theme);
  }
  if (!isPartial && (details?.action === "start" || details?.action === "await") && details.runs) {
    const failures = details.startFailures ?? [];
    const banner = details.action === "await" ? awaitResultBanner(details) : undefined;
    if (expanded) return renderExpandedStartAwaitResult(details.runs, theme, failures, banner);
    return renderStartAwaitOverviewComponent(details.runs, theme, failures, banner);
  }
  let text = sanitizeTerminalText(
    result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n"),
  );
  if (!expanded) {
    const lines = text.split("\n");
    if (lines.length > 12) text = `${lines.slice(0, 12).join("\n")}\n…`;
  }
  return new Text(
    theme.fg(isPartial ? "warning" : "toolOutput", text || (isPartial ? "Working…" : "Done")),
    0,
    0,
  );
};

export function registerSubagentTools(pi: ExtensionAPI, runtime: SubagentToolRuntime): void {
  const sharedRenderResult = (
    result: Parameters<typeof renderSubagentResult>[0],
    options: { readonly isPartial: boolean; readonly expanded: boolean },
    theme: Theme,
  ) => renderSubagentResult(result, options.isPartial, options.expanded, theme);

  const models = defineTool({
    name: "subagent_models",
    label: "Subagent Models",
    description:
      "Discover deterministic subagent profiles plus accepted explicit model selectors. Profile output shows default context, ordered candidates, skips, and fallback. Denied selectors are hidden; discouraged selectors are marked explicit-only. All model search terms must match.",
    parameters: ModelsParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { action: "models", ...input }, signal, onUpdate, ctx),
    renderCall: (args, theme) => renderSubagentCall("subagent_models", args.query ?? "", theme),
    renderResult: sharedRenderResult,
  });

  const start = defineTool({
    name: "subagent_start",
    label: "Start Subagents",
    description:
      "Launch one to twelve session-scoped subagents from one agents array. Backend is required: use auto for deterministic profile routing or pi/claude-cli for an explicit override. Background is the default; at most one foreground agent is allowed. Successful launches remain active when a peer launch fails.",
    promptSnippet: "Launch delegated subagents using a task profile and explicit write intent",
    promptGuidelines: [
      "Use subagent_start for delegated work that can proceed independently; background is the default launch mode, and each call accepts at most one foreground agent.",
      "Every subagent_start agent must explicitly declare writeIntent as writer or read-only and must provide backend; prefer backend=auto unless the user requests a model or backend capabilities require an explicit choice.",
      "Choose a profile by task: scout for local reconnaissance, researcher for sourced external research, planner for plans, worker for implementation, reviewer for independent review, oracle for inherited-decision analysis, and delegate for general work.",
      "Keep only one writer in the shared cwd, counting the main agent itself; do not edit while a writer subagent is active.",
      "Parallelize read-only research, inspection, and review; serialize writes unless isolated worktrees are introduced later.",
      "Use subagent_models to inspect profile routing or explicit launch-ready selectors; never substitute an arbitrary model when a profile has no eligible candidate.",
      'Backend "auto" cannot combine with model. Explicit backend "pi" takes an authenticated canonical provider/model (or inherits the parent); "claude-cli" takes only a Claude alias or full Claude model ID.',
      "Choose backend pi when the child may need mid-turn guidance, interruption, or parent questions; claude-cli supports await, stop, local rename, and resume after completion but not those interactive controls.",
    ],
    parameters: StartParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { action: "start", ...input }, signal, onUpdate, ctx),
    renderCall: (args, theme) =>
      renderSubagentCall(
        "subagent_start",
        args.agents.map((agent) => agent.name ?? agent.task).join(", "),
        theme,
      ),
    renderResult: sharedRenderResult,
  });

  const list = defineTool({
    name: "subagent_list",
    label: "List Subagents",
    description: "List every session-scoped subagent run in compact form.",
    parameters: ListParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { action: "list", ...input }, signal, onUpdate, ctx),
    renderCall: (_args, theme) => renderSubagentCall("subagent_list", "", theme),
    renderResult: sharedRenderResult,
  });

  const status = defineTool({
    name: "subagent_status",
    label: "Subagent Status",
    description:
      "Inspect up to twelve specific subagent run IDs, including each run's backend capabilities.",
    parameters: StatusParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { action: "status", ...input }, signal, onUpdate, ctx),
    renderCall: (args, theme) =>
      renderSubagentCall("subagent_status", args.runIds.join(", "), theme),
    renderResult: sharedRenderResult,
  });

  const awaitTool = defineTool({
    name: "subagent_await",
    label: "Await Subagents",
    description:
      "Wait for selected background subagents to finish, with live progress and an explicit timeout; use zero for no timeout. Returns early if a Pi subagent needs a parent reply, then call it again after subagent_reply.",
    promptSnippet: "Wait for background subagents and collect their final reports",
    promptGuidelines: [
      "Do not poll subagent_status. After independent work, call subagent_await to collect results; if it returns for a parent question, use subagent_reply and then call subagent_await again. Use subagent_status only for troubleshooting or a user-requested snapshot.",
    ],
    parameters: AwaitParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { action: "await", ...input }, signal, onUpdate, ctx),
    renderCall: (args, theme) =>
      renderSubagentCall("subagent_await", args.runIds.join(", "), theme),
    renderResult: sharedRenderResult,
  });

  const send = defineTool({
    name: "subagent_send",
    label: "Send Subagent Guidance",
    description:
      "Send the same guidance message to one or more running Pi-backend subagents. claude-cli runs cannot receive mid-turn guidance; await, stop, or resume them after completion instead. Mixed-target calls report each success and failure.",
    parameters: SendParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { action: "send", ...input }, signal, onUpdate, ctx),
    renderCall: (args, theme) => renderSubagentCall("subagent_send", args.runIds.join(", "), theme),
    renderResult: sharedRenderResult,
  });

  const reply = defineTool({
    name: "subagent_reply",
    label: "Reply to Subagent",
    description:
      "Answer a blocking parent question from one Pi-backend subagent. claude-cli runs do not support parent questions.",
    parameters: ReplyParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { action: "reply", ...input }, signal, onUpdate, ctx),
    renderCall: (args, theme) => renderSubagentCall("subagent_reply", args.runId, theme),
    renderResult: sharedRenderResult,
  });

  const lifecycle = defineTool({
    name: "subagent_lifecycle",
    label: "Subagent Lifecycle",
    description:
      "Interrupt, resume, or stop one or more subagents. Interrupt pauses Pi-backend runs; claude-cli runs cannot be interrupted but can be stopped or resumed after completion. Message is valid only for resume. Mixed-target calls report each success and failure.",
    parameters: LifecycleParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, input, signal, onUpdate, ctx),
    renderCall: (args, theme) =>
      renderSubagentCall("subagent_lifecycle", `${args.action} ${args.runIds.join(", ")}`, theme),
    renderResult: sharedRenderResult,
  });

  const rename = defineTool({
    name: "subagent_rename",
    label: "Rename Subagent",
    description: "Change one subagent's local display name.",
    parameters: RenameParameters,
    execute: (_id, input, signal, onUpdate, ctx) =>
      executeSubagentAction(pi, runtime, { action: "rename", ...input }, signal, onUpdate, ctx),
    renderCall: (args, theme) =>
      renderSubagentCall("subagent_rename", `${args.runId} → ${args.name}`, theme),
    renderResult: sharedRenderResult,
  });

  for (const tool of [models, start, list, status, awaitTool, send, reply, lifecycle, rename])
    pi.registerTool(withCodePreviewShell(tool));
}
