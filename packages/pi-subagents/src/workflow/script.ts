import {
  parse,
  type ArrayExpression,
  type Expression,
  type Literal,
  type Node,
  type ObjectExpression,
  type Program,
  type Property,
  type UnaryExpression,
} from "acorn";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { sha256Text } from "pi-cosmic-core";

/** Workflow scripts are model-authored programs, never bulk data. */
export const WORKFLOW_SCRIPT_MAX_CHARS = 256 * 1024;
export const WORKFLOW_PHASE_LIMIT = 64;
/** Planned agents one meta phase may declare. */
export const WORKFLOW_PHASE_AGENT_LIMIT = 64;
/** Planned agents one script may declare across its phases. */
export const WORKFLOW_SCRIPT_AGENT_LIMIT = 256;

export class WorkflowScriptError extends Schema.TaggedError<WorkflowScriptError>()(
  "WorkflowScriptError",
  { message: Schema.String },
) {}

const Text = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

/** A display-only agent a phase plans to run: a label, or a label with its profile. */
const WorkflowPlannedAgentSchema = Schema.Union([
  Text(80),
  Schema.Struct({ label: Text(80), profile: Schema.optional(Text(80)) }),
]);

/**
 * A phase title, trimmed once here to the form runtime `phase()` titles take, so meta phases,
 * their planned agents and the phases calls name all match.
 */
const PhaseTitle = Schema.String.pipe(Schema.decode(SchemaTransformation.trim())).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(160),
);

const WorkflowPhaseSchema = Schema.Struct({
  title: PhaseTitle,
  detail: Schema.optional(Text(1_000)),
  agents: Schema.optional(
    Schema.Array(WorkflowPlannedAgentSchema).check(Schema.isMaxLength(WORKFLOW_PHASE_AGENT_LIMIT)),
  ),
});

export const WorkflowMetaSchema = Schema.Struct({
  name: Text(80),
  description: Text(1_000),
  whenToUse: Schema.optional(Text(1_000)),
  phases: Schema.optional(
    Schema.Array(WorkflowPhaseSchema).check(Schema.isMaxLength(WORKFLOW_PHASE_LIMIT)),
  ),
});

export type WorkflowMeta = typeof WorkflowMetaSchema.Type;
export type WorkflowPhase = typeof WorkflowPhaseSchema.Type;

/** A planned agent as a run shows it, before it reserves a run id. */
export interface WorkflowPlannedAgentSpec {
  readonly phase: string;
  readonly label: string;
  readonly profile?: string | undefined;
}

/** A phase's planned agents in declaration order, labels and profiles trimmed. */
export const workflowPlannedAgents = (
  phase: WorkflowPhase,
  title = phase.title,
): ReadonlyArray<WorkflowPlannedAgentSpec> =>
  (phase.agents ?? []).map((agent) => {
    const { label, profile } = Predicate.isString(agent)
      ? { label: agent, profile: undefined }
      : agent;
    const shownProfile = profile?.trim();
    return { phase: title, label: label.trim(), ...(shownProfile && { profile: shownProfile }) };
  });

/** Why the declared planned agents are invalid beyond their shape, if they are. */
const plannedAgentsProblem = (meta: WorkflowMeta): string | undefined => {
  const phases = meta.phases ?? [];
  const planned = phases.flatMap((phase) => workflowPlannedAgents(phase));
  if (planned.length > WORKFLOW_SCRIPT_AGENT_LIMIT)
    return `Invalid meta: phases declare ${planned.length} planned agents; a script can declare at most ${WORKFLOW_SCRIPT_AGENT_LIMIT}.`;
  const blank = phases.findIndex((phase) =>
    workflowPlannedAgents(phase).some((agent) => agent.label === ""),
  );
  return blank === -1
    ? undefined
    : `Invalid meta: planned agent labels can't be blank, in phase "${phases[blank]?.title}".`;
};

export interface WorkflowScript {
  readonly meta: WorkflowMeta;
  /** The script exactly as given, which each run saves for the main agent to edit. */
  readonly source: string;
  /** The script with `export` removed from its meta declaration; line and column positions are unchanged. */
  readonly body: string;
  readonly sha256: string;
}

const decodeMeta = Schema.decodeUnknownEffect(WorkflowMetaSchema, { onExcessProperty: "error" });

const META_DECLARATION_REQUIRED =
  "A workflow script must begin with `export const meta = { name, description }`.";

type MetaValue = string | number | boolean | null | readonly MetaValue[] | MetaRecord;
interface MetaRecord {
  readonly [key: string]: MetaValue;
}

/** Marks an expression that is not a pure literal. */
const NOT_LITERAL: unique symbol = Symbol("not-literal");
type Evaluated = MetaValue | typeof NOT_LITERAL;

const decodeScalar = Schema.decodeUnknownOption(
  Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]),
);

const propertyKey = (key: Expression): string | undefined =>
  key.type === "Identifier"
    ? key.name
    : key.type === "Literal"
      ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.String)(key.value))
      : undefined;

const scalarLiteral = (node: Literal): Evaluated =>
  node.regex || node.bigint !== undefined
    ? NOT_LITERAL
    : Option.getOrElse(decodeScalar(node.value), (): Evaluated => NOT_LITERAL);

const negativeLiteral = (node: UnaryExpression): Evaluated => {
  if (node.operator !== "-" || node.argument.type !== "Literal") return NOT_LITERAL;
  return Option.match(Schema.decodeUnknownOption(Schema.Finite)(node.argument.value), {
    onNone: (): Evaluated => NOT_LITERAL,
    onSome: (value) => -value,
  });
};

function arrayLiteral(node: ArrayExpression): Evaluated {
  const values: MetaValue[] = [];
  for (const element of node.elements) {
    const value =
      element === null || element.type === "SpreadElement" ? NOT_LITERAL : literalValue(element);
    if (value === NOT_LITERAL) return NOT_LITERAL;
    values.push(value);
  }
  return values;
}

const isPlainProperty = (property: ObjectExpression["properties"][number]): property is Property =>
  property.type === "Property" &&
  property.kind === "init" &&
  !property.method &&
  !property.computed &&
  !property.shorthand;

function objectLiteral(node: ObjectExpression): Evaluated {
  const entries: Array<readonly [string, MetaValue]> = [];
  for (const property of node.properties) {
    if (!isPlainProperty(property)) return NOT_LITERAL;
    const key = propertyKey(property.key);
    const value = key === undefined ? NOT_LITERAL : literalValue(property.value);
    if (key === undefined || value === NOT_LITERAL) return NOT_LITERAL;
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

/** Evaluates a pure-literal meta expression without executing anything. */
function literalValue(node: Expression): Evaluated {
  switch (node.type) {
    case "Literal":
      return scalarLiteral(node);
    case "TemplateLiteral":
      return node.expressions.length > 0
        ? NOT_LITERAL
        : node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      return negativeLiteral(node);
    case "ArrayExpression":
      return arrayLiteral(node);
    case "ObjectExpression":
      return objectLiteral(node);
    default:
      return NOT_LITERAL;
  }
}

const isModuleDeclaration = (node: Node): boolean =>
  node.type === "ImportDeclaration" ||
  node.type === "ExportNamedDeclaration" ||
  node.type === "ExportDefaultDeclaration" ||
  node.type === "ExportAllDeclaration";

function parseProgram(source: string): Program {
  try {
    return parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: true,
    });
  } catch (error) {
    throw new WorkflowScriptError({
      message: `SyntaxError: ${error instanceof Error ? error.message : String(error)}. Scripts are plain JavaScript, not TypeScript.`,
    });
  }
}

/**
 * Validates a workflow script before anything runs: plain JavaScript that begins with a
 * pure-literal `export const meta` and has no other module syntax.
 */
export const parseWorkflowScript = (
  source: string,
): Effect.Effect<WorkflowScript, WorkflowScriptError> =>
  Effect.gen(function* () {
    if (source.length > WORKFLOW_SCRIPT_MAX_CHARS)
      return yield* new WorkflowScriptError({
        message: `Workflow scripts are limited to ${WORKFLOW_SCRIPT_MAX_CHARS} characters.`,
      });
    const program = yield* Effect.try({
      try: () => parseProgram(source),
      catch: (error) =>
        error instanceof WorkflowScriptError
          ? error
          : new WorkflowScriptError({ message: String(error) }),
    });
    const [first, ...rest] = program.body;
    const declaration =
      first?.type === "ExportNamedDeclaration" && first.declaration?.type === "VariableDeclaration"
        ? first.declaration
        : undefined;
    const declarator = declaration?.kind === "const" ? declaration.declarations[0] : undefined;
    if (
      !first ||
      !declarator ||
      declaration?.declarations.length !== 1 ||
      declarator.id.type !== "Identifier" ||
      declarator.id.name !== "meta" ||
      !declarator.init
    )
      return yield* new WorkflowScriptError({ message: META_DECLARATION_REQUIRED });
    if (rest.some(isModuleDeclaration))
      return yield* new WorkflowScriptError({
        message:
          "Only `export const meta` is allowed; workflow scripts can't import or export anything else.",
      });
    const raw = literalValue(declarator.init);
    if (raw === NOT_LITERAL)
      return yield* new WorkflowScriptError({
        message:
          "`meta` must be a pure literal: no variables, calls, spreads, or template interpolation.",
      });
    const meta = yield* decodeMeta(raw).pipe(
      Effect.mapError(
        (error) => new WorkflowScriptError({ message: `Invalid meta: ${error.message}` }),
      ),
    );
    const problem = plannedAgentsProblem(meta);
    if (problem !== undefined) return yield* new WorkflowScriptError({ message: problem });
    // Keep `const meta` so the script can read it; blanking `export` keeps every position intact.
    const body = `${source.slice(0, first.start)}${" ".repeat("export".length)}${source.slice(first.start + "export".length)}`;
    return { meta, source, body, sha256: sha256Text(source) };
  });
