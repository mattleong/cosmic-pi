import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { sha256Text } from "pi-cosmic-core";
import { PROFILE_IDS, type ProfileId } from "../profiles/model.ts";
import { WorkflowAgentCallError } from "./errors.ts";
import { NonEmptyText, workflowAgentLabel, workflowPhaseTitle } from "./model.ts";

const invalidOptions = (message: string) => new WorkflowAgentCallError({ message });

const DEFAULT_PROFILE: ProfileId = "generalist";

export const workflowAgentProfile = (profile: string | undefined): string =>
  profile ?? DEFAULT_PROFILE;

export const AVAILABLE_PROFILES = `Available profiles: ${PROFILE_IDS.join(", ")}.`;

const ROUTE_OPTIONS = ["model", "effort", "agentType"] as const;
type WorkflowRouteOption = (typeof ROUTE_OPTIONS)[number];

const nearestProfile = (agentType: Schema.Json): ProfileId | undefined => {
  if (!Predicate.isString(agentType)) return undefined;
  const type = agentType.trim().toLowerCase();
  if (type === "explore") return "scout";
  if (type === "plan") return "planner";
  if (type === "general-purpose") return "generalist";
  return type.includes("review") ? "reviewer" : undefined;
};

const workflowRouteOptionMessage = (option: WorkflowRouteOption, value: Schema.Json): string => {
  if (option !== "agentType")
    return `agent() option \`${option}\` isn't supported: Pi profiles choose the model and effort. Pass \`profile\` instead. ${AVAILABLE_PROFILES}`;
  const nearest = nearestProfile(value);
  return nearest === undefined
    ? `agent() option \`agentType\` isn't supported: Pi runs profiles, not agent types. Pass \`profile\` instead. ${AVAILABLE_PROFILES}`
    : `agent() option \`agentType\` isn't supported: Pi runs profiles, not agent types. Pass profile: "${nearest}" instead of agentType: ${JSON.stringify(value)}.`;
};

const WorkflowAgentOptionsSchema = Schema.Struct({
  label: Schema.optional(Schema.String),
  phase: Schema.optional(Schema.String),
  schema: Schema.optional(Schema.Json),
  profile: Schema.optional(NonEmptyText(80)),
  isolation: Schema.optional(Schema.Literal("worktree")),
  writes: Schema.optional(
    Schema.Array(NonEmptyText(4_096)).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  ),
});

export type WorkflowAgentOptions = typeof WorkflowAgentOptionsSchema.Type;

const SUPPORTED = Object.keys(WorkflowAgentOptionsSchema.fields);
const isRouteOption = Schema.is(Schema.Literals(ROUTE_OPTIONS));

const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));
const decodeOptions = Schema.decodeUnknownEffect(WorkflowAgentOptionsSchema);

export const decodeWorkflowAgentOptions = (
  raw: Schema.Json,
): Effect.Effect<WorkflowAgentOptions, WorkflowAgentCallError> =>
  Effect.gen(function* () {
    const record = decodeRecord(raw);
    if (Option.isNone(record)) return yield* invalidOptions("agent() options must be an object.");
    const keys = Object.keys(record.value);
    const route = keys.find(isRouteOption);
    if (route !== undefined)
      return yield* invalidOptions(workflowRouteOptionMessage(route, record.value[route] ?? null));
    const unknown = keys.find((key) => !SUPPORTED.includes(key));
    if (unknown !== undefined)
      return yield* invalidOptions(
        `Unknown agent() option \`${unknown}\`. Supported options: ${SUPPORTED.join(", ")}.`,
      );
    const present = Object.fromEntries(
      Object.entries(record.value).filter(([, value]) => value !== null),
    );
    const { label, phase, profile, ...options } = yield* decodeOptions(present).pipe(
      Effect.mapError((error) => invalidOptions(`Invalid agent() options: ${error.message}`)),
    );
    const shownLabel = label === undefined ? undefined : workflowAgentLabel(label);
    const shownPhase = phase === undefined ? undefined : workflowPhaseTitle(phase) || undefined;
    const named = (profile?.trim() ?? "") || undefined;
    return {
      ...options,
      ...(shownLabel !== undefined && { label: shownLabel }),
      ...(shownPhase !== undefined && { phase: shownPhase }),
      ...(named !== undefined && { profile: named }),
    };
  });

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
      options.writes ? [...options.writes].toSorted() : null,
    ]),
  );
