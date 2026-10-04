import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { sha256Text } from "pi-cosmic-core";
import { PROFILE_IDS, type ProfileId } from "../profiles/model.ts";
import { workflowAgentLabel, workflowPhaseTitle } from "./model.ts";

export class WorkflowAgentOptionsError extends Schema.TaggedError<WorkflowAgentOptionsError>()(
  "WorkflowAgentOptionsError",
  { message: Schema.String },
) {}

/** The profile an agent() call without one runs with. */
const DEFAULT_PROFILE: ProfileId = "generalist";

/** The profile a call runs with: the one it names, or the default. */
export const workflowAgentProfile = (profile: string | undefined): string =>
  profile ?? DEFAULT_PROFILE;

/** Every profile a call can name, as messages list them. */
export const AVAILABLE_PROFILES = `Available profiles: ${PROFILE_IDS.join(", ")}.`;

/** Claude Code options that choose an agent's route, which Pi profiles choose instead. */
const ROUTE_OPTIONS = ["model", "effort", "agentType"] as const;
type WorkflowRouteOption = (typeof ROUTE_OPTIONS)[number];

/** The Pi profile nearest a Claude Code agent type, when one is close enough to name. */
const nearestProfile = (agentType: Schema.Json): ProfileId | undefined => {
  if (!Predicate.isString(agentType)) return undefined;
  const type = agentType.trim().toLowerCase();
  if (type === "explore") return "scout";
  if (type === "plan") return "planner";
  if (type === "general-purpose") return "generalist";
  return type.includes("review") ? "reviewer" : undefined;
};

/** What a script passing a Claude Code route option should pass instead. */
const workflowRouteOptionMessage = (option: WorkflowRouteOption, value: Schema.Json): string => {
  if (option !== "agentType")
    return `agent() option \`${option}\` isn't supported: Pi profiles choose the model and effort. Pass \`profile\` instead. ${AVAILABLE_PROFILES}`;
  const nearest = nearestProfile(value);
  return nearest === undefined
    ? `agent() option \`agentType\` isn't supported: Pi runs profiles, not agent types. Pass \`profile\` instead. ${AVAILABLE_PROFILES}`
    : `agent() option \`agentType\` isn't supported: Pi runs profiles, not agent types. Pass profile: "${nearest}" instead of agentType: ${JSON.stringify(value)}.`;
};

const Text = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

export const WorkflowAgentOptionsSchema = Schema.Struct({
  // Presentation only: decoding clips long values and drops empty ones instead of rejecting.
  label: Schema.optional(Schema.String),
  phase: Schema.optional(Schema.String),
  schema: Schema.optional(Schema.Json),
  profile: Schema.optional(Text(80)),
  isolation: Schema.optional(Schema.Literal("worktree")),
  writes: Schema.optional(
    Schema.Array(Text(4_096)).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  ),
});

export type WorkflowAgentOptions = typeof WorkflowAgentOptionsSchema.Type;

const SUPPORTED = ["label", "phase", "schema", "profile", "isolation", "writes"];
const isRouteOption = Schema.is(Schema.Literals(ROUTE_OPTIONS));

const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));
const decodeOptions = Schema.decodeUnknownEffect(WorkflowAgentOptionsSchema, {
  onExcessProperty: "error",
});

/**
 * Decodes script-supplied agent() options strictly, naming the first route option, with the
 * profile to pass instead, or else the first unsupported option. Null values count as omitted,
 * and the profile is trimmed, so calls that run the same route have the same options.
 */
export const decodeWorkflowAgentOptions = (
  raw: Schema.Json,
): Effect.Effect<WorkflowAgentOptions, WorkflowAgentOptionsError> =>
  Effect.gen(function* () {
    const record = decodeRecord(raw);
    if (Option.isNone(record))
      return yield* new WorkflowAgentOptionsError({
        message: "agent() options must be an object.",
      });
    const keys = Object.keys(record.value);
    const route = keys.find(isRouteOption);
    if (route !== undefined)
      return yield* new WorkflowAgentOptionsError({
        message: workflowRouteOptionMessage(route, record.value[route] ?? null),
      });
    const unknown = keys.find((key) => !SUPPORTED.includes(key));
    if (unknown !== undefined)
      return yield* new WorkflowAgentOptionsError({
        message: `Unknown agent() option \`${unknown}\`. Supported options: ${SUPPORTED.join(", ")}.`,
      });
    // A null option counts as omitted, so scripts can pass nullable values straight through.
    const present = Object.fromEntries(
      Object.entries(record.value).filter(([, value]) => value !== null),
    );
    const { label, phase, profile, ...options } = yield* decodeOptions(present).pipe(
      Effect.mapError(
        (error) =>
          new WorkflowAgentOptionsError({ message: `Invalid agent() options: ${error.message}` }),
      ),
    );
    const shownLabel = label === undefined ? undefined : workflowAgentLabel(label);
    const shownPhase = phase === undefined ? undefined : workflowPhaseTitle(phase) || undefined;
    const named = profile?.trim() || undefined;
    return {
      ...options,
      ...(shownLabel !== undefined && { label: shownLabel }),
      ...(shownPhase !== undefined && { phase: shownPhase }),
      ...(named !== undefined && { profile: named }),
    };
  });

/**
 * Identity of an agent() call for resume: the same prompt with the same route-affecting options
 * reuses an earlier result. Display options (label, phase) don't matter, and an omitted profile
 * is the default one it runs with.
 */
export const workflowAgentJournalKey = (
  prompt: string,
  options: WorkflowAgentOptions,
  schemaDigest: string | undefined,
): string =>
  sha256Text(
    JSON.stringify([
      prompt,
      workflowAgentProfile(options.profile),
      schemaDigest ?? null,
      options.isolation ?? null,
      options.writes ? [...options.writes].sort() : null,
    ]),
  );
