import {
  parse,
  type ArrayExpression,
  type Expression,
  type Literal,
  type Node,
  type ObjectExpression,
  type Property,
  type UnaryExpression,
} from "acorn";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { compileWorkflowArgs, type WorkflowArgsContract } from "./args.ts";
import { NonEmptyText, WORKFLOW_PHASE_TITLE_MAX_CHARS } from "./model.ts";

/** Workflow scripts are model-authored programs, never bulk data. */
export const WORKFLOW_SCRIPT_MAX_CHARS = 256 * 1024;
const WORKFLOW_PHASE_LIMIT = 64;
/** Planned agents one meta phase may declare. */
export const WORKFLOW_PHASE_AGENT_LIMIT = 64;
/** Planned agents one script may declare across its phases. */
export const WORKFLOW_SCRIPT_AGENT_LIMIT = 256;

/** Where a script stopped parsing: the parser's message without its position, and its line. */
const WorkflowSyntaxProblem = Schema.Struct({
  reason: Schema.String,
  line: Schema.optional(Schema.Finite),
});

/** A script that doesn't parse, carrying `syntax`, or that isn't a valid workflow. */
export class WorkflowScriptError extends Schema.TaggedError<WorkflowScriptError>()(
  "WorkflowScriptError",
  { message: Schema.String, syntax: Schema.optional(WorkflowSyntaxProblem) },
) {}

/**
 * An agent a phase plans to run: a label, or a label with its profile. It starts nothing and sets
 * no options, but the user can skip it before it starts.
 */
const WorkflowPlannedAgentSchema = Schema.Union([
  NonEmptyText(80),
  Schema.Struct({ label: NonEmptyText(80), profile: Schema.optional(NonEmptyText(80)) }),
]);

/**
 * A phase title, trimmed once here to the form runtime `phase()` titles take, so meta phases,
 * their planned agents and the phases calls name all match.
 */
const PhaseTitle = Schema.String.pipe(Schema.decode(SchemaTransformation.trim())).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(WORKFLOW_PHASE_TITLE_MAX_CHARS),
);

const WorkflowPhaseSchema = Schema.Struct({
  title: PhaseTitle,
  detail: Schema.optional(NonEmptyText(1_000)),
  agents: Schema.optional(
    Schema.Array(WorkflowPlannedAgentSchema).check(Schema.isMaxLength(WORKFLOW_PHASE_AGENT_LIMIT)),
  ),
});

const WorkflowMetaSchema = Schema.Struct({
  name: NonEmptyText(80),
  description: NonEmptyText(1_000),
  whenToUse: Schema.optional(NonEmptyText(1_000)),
  phases: Schema.optional(
    Schema.Array(WorkflowPhaseSchema).check(Schema.isMaxLength(WORKFLOW_PHASE_LIMIT)),
  ),
  /** A JSON Schema for the script's `args`; compiled, and so bounded, when the script is parsed. */
  args: Schema.optional(Schema.Json),
});

export type WorkflowMeta = typeof WorkflowMetaSchema.Type;
export type WorkflowPhase = typeof WorkflowPhaseSchema.Type;

/** A planned agent as a run shows it, before it reserves a run id. */
export interface WorkflowPlannedAgentSpec {
  readonly phase: string;
  readonly label: string;
  readonly profile?: string | undefined;
  /**
   * The nested workflow() whose meta declares it, by name; absent for the run's own script. Only
   * calls made in that workflow claim it outside a phase.
   */
  readonly workflow?: string | undefined;
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
  const planned = (meta.phases ?? []).flatMap((phase) => workflowPlannedAgents(phase));
  if (planned.length > WORKFLOW_SCRIPT_AGENT_LIMIT)
    return `Invalid meta: phases declare ${planned.length} planned agents; a script can declare at most ${WORKFLOW_SCRIPT_AGENT_LIMIT}.`;
  const blank = planned.find((agent) => agent.label === "");
  return blank === undefined
    ? undefined
    : `Invalid meta: planned agent labels can't be blank, in phase "${blank.phase}".`;
};

export interface WorkflowScript {
  readonly meta: WorkflowMeta;
  /** The compiled `meta.args`; absent when the script accepts any args. */
  readonly args?: WorkflowArgsContract | undefined;
  /** The script exactly as given, which each run saves for the main agent to edit. */
  readonly source: string;
  /** The script with `export` removed from its meta declaration; line and column positions are unchanged. */
  readonly body: string;
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
    : key.type === "Literal" && Predicate.isString(key.value)
      ? key.value
      : undefined;

const scalarLiteral = (node: Literal): Evaluated =>
  node.regex || node.bigint !== undefined
    ? NOT_LITERAL
    : Option.getOrElse(decodeScalar(node.value), (): Evaluated => NOT_LITERAL);

const negativeLiteral = (node: UnaryExpression): Evaluated => {
  if (node.operator !== "-" || node.argument.type !== "Literal") return NOT_LITERAL;
  const value = node.argument.value;
  return Predicate.isNumber(value) && Number.isFinite(value) ? -value : NOT_LITERAL;
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

const SyntaxPosition = Schema.Struct({ line: Schema.Finite, column: Schema.Finite });

/** The position acorn's syntax error carries beside its message; its column counts from 0. */
const decodeSyntaxPosition = Schema.decodeUnknownOption(Schema.Struct({ loc: SyntaxPosition }));

const EXCERPT_BEFORE = 60;
const EXCERPT_AFTER = 40;

/**
 * The failing line around the parser's position, with a caret under it, so a long one-line
 * script can be fixed in one try instead of guessing at a column.
 */
const syntaxExcerpt = (source: string, line: number, column: number): string => {
  const text = source.split("\n")[line - 1];
  if (text === undefined) return "";
  const from = Math.max(0, column - EXCERPT_BEFORE);
  const to = Math.min(text.length, column + EXCERPT_AFTER);
  const lead = from > 0 ? "…" : "";
  const tail = to < text.length ? "…" : "";
  return `\n  ${lead}${text.slice(from, to)}${tail}\n  ${" ".repeat(lead.length + column - from)}^`;
};

/** Why the parser rejected the script, where, and the code around it. */
const syntaxError = (
  source: string,
  message: string,
  position: typeof SyntaxPosition.Type | undefined,
): WorkflowScriptError => {
  // Fits both a slip, such as an unclosed bracket, and TypeScript syntax.
  const near = position === undefined ? "" : ` near line ${position.line}`;
  const excerpt =
    position === undefined ? "" : syntaxExcerpt(source, position.line, position.column);
  return new WorkflowScriptError({
    message: `SyntaxError: ${message}. Check the syntax${near} (scripts are plain JavaScript, without TypeScript types).${excerpt}`,
    syntax: {
      // Acorn ends its message with the position, which `line` carries instead.
      reason: message.replace(/\s*\(\d+:\d+\)$/u, ""),
      ...(position !== undefined && { line: position.line }),
    },
  });
};

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
      try: () =>
        parse(source, {
          ecmaVersion: "latest",
          sourceType: "module",
          allowAwaitOutsideFunction: true,
          allowReturnOutsideFunction: true,
          locations: true,
        }),
      catch: (error) =>
        syntaxError(
          source,
          error instanceof Error ? error.message : String(error),
          Option.getOrUndefined(decodeSyntaxPosition(error))?.loc,
        ),
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
    const args =
      meta.args === undefined
        ? undefined
        : yield* compileWorkflowArgs(meta.args).pipe(
            Effect.mapError(
              (error) =>
                new WorkflowScriptError({ message: `Invalid meta.args: ${error.message}` }),
            ),
          );
    // Keep `const meta` so the script can read it; blanking `export` keeps every position intact.
    const body = `${source.slice(0, first.start)}${" ".repeat("export".length)}${source.slice(first.start + "export".length)}`;
    return { meta, source, body, ...(args && { args }) };
  });
