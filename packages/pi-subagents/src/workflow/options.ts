import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { sha256Text } from "pi-cosmic-core";
import { workflowAgentLabel, workflowPhaseTitle } from "./model.ts";

export class WorkflowAgentOptionsError extends Schema.TaggedError<WorkflowAgentOptionsError>()(
  "WorkflowAgentOptionsError",
  { message: Schema.String },
) {}

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
const ROUTE_OPTIONS = new Set(["model", "effort", "agentType"]);

const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));
const decodeOptions = Schema.decodeUnknownEffect(WorkflowAgentOptionsSchema, {
  onExcessProperty: "error",
});

const unsupportedKey = (keys: ReadonlyArray<string>): string | undefined => {
  const route = keys.find((key) => ROUTE_OPTIONS.has(key));
  if (route !== undefined)
    return `agent() option \`${route}\` isn't supported: Pi profiles choose the model and effort. Pass \`profile\` instead.`;
  const unknown = keys.find((key) => !SUPPORTED.includes(key));
  return unknown === undefined
    ? undefined
    : `Unknown agent() option \`${unknown}\`. Supported options: ${SUPPORTED.join(", ")}.`;
};

/**
 * Decodes script-supplied agent() options strictly, naming the first unsupported option. Null
 * values count as omitted.
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
    const unsupported = unsupportedKey(Object.keys(record.value));
    if (unsupported !== undefined)
      return yield* new WorkflowAgentOptionsError({ message: unsupported });
    // A null option counts as omitted, so scripts can pass nullable values straight through.
    const present = Object.fromEntries(
      Object.entries(record.value).filter(([, value]) => value !== null),
    );
    const { label, phase, ...options } = yield* decodeOptions(present).pipe(
      Effect.mapError(
        (error) =>
          new WorkflowAgentOptionsError({ message: `Invalid agent() options: ${error.message}` }),
      ),
    );
    const shownLabel = label === undefined ? undefined : workflowAgentLabel(label);
    const shownPhase = phase === undefined ? undefined : workflowPhaseTitle(phase) || undefined;
    return {
      ...options,
      ...(shownLabel !== undefined && { label: shownLabel }),
      ...(shownPhase !== undefined && { phase: shownPhase }),
    };
  });

/**
 * Identity of an agent() call for resume: the same prompt with the same route-affecting options
 * reuses an earlier result. Display options (label, phase) don't matter.
 */
export const workflowAgentJournalKey = (
  prompt: string,
  options: WorkflowAgentOptions,
  schemaDigest: string | undefined,
): string =>
  sha256Text(
    JSON.stringify([
      prompt,
      options.profile ?? null,
      schemaDigest ?? null,
      options.isolation ?? null,
      options.writes ? [...options.writes].sort() : null,
    ]),
  );
