import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { clipText } from "pi-cosmic-core";
import {
  canonicalJsonText,
  checkJsonSchema,
  decodeJsonRecord,
  importJsonSchema,
  type InvalidJsonSchemaError,
  type JsonRecord,
} from "../domain/json-schema.ts";
import {
  workflowRequestError,
  type WorkflowArgsProblem,
  type WorkflowRequestError,
} from "./errors.ts";
import { WORKFLOW_ARGS_MAX_CHARS } from "./model.ts";

/** The args summary saved-workflow listings and refusals show. */
export const WORKFLOW_ARGS_SUMMARY_MAX_CHARS = 200;
/** Problems one refusal names; the rest are counted. */
const ARGS_PROBLEMS_SHOWN = 8;
const ARGS_PATH_MAX_CHARS = 120;
const ARGS_PROBLEM_MAX_CHARS = 200;

/**
 * A script's `meta.args` compiled. The schema is the JSON Schema subset `agent()` schemas accept,
 * at any root, since args may be any JSON value: unlike a result schema, it never becomes tool
 * parameters, so a non-object root is validated as written instead of being wrapped.
 */
export interface WorkflowArgsContract {
  /** A compact form of the schema, such as `{ target: string, depth?: integer }`. */
  readonly summary: string;
  /** The ways `args` (null when omitted) doesn't match the schema; empty when it does. */
  readonly check: (args: Schema.Json) => Effect.Effect<ReadonlyArray<WorkflowArgsProblem>>;
}

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
const decodeArray = Schema.decodeUnknownOption(Schema.Array(Schema.Json));
const decodeStrings = Schema.decodeUnknownOption(Schema.Array(Schema.String));
const encodeJson = Schema.encodeOption(Schema.fromJsonString(Schema.Json));

/** A property name as a summary or path shows it: bare when it is an identifier. */
const keyText = (key: string): string => (IDENTIFIER.test(key) ? key : canonicalJsonText(key));

const segmentKey = (segment: PropertyKey | { readonly key: PropertyKey }): PropertyKey =>
  Predicate.isObject(segment) ? segment.key : segment;

/** Where a problem is, from the args root: `args`, `args.target`, `args.files[0]["a b"]`. */
const pathText = (path: ReadonlyArray<PropertyKey>): string =>
  path.reduce<string>((text, key) => {
    if (Predicate.isNumber(key)) return `${text}[${key}]`;
    const name = String(key);
    return IDENTIFIER.test(name) ? `${text}.${name}` : `${text}[${canonicalJsonText(name)}]`;
  }, "args");

/** The schema node the value at `path` is checked against; undefined past a combinator. */
const nodeAt = (root: JsonRecord, path: ReadonlyArray<PropertyKey>): JsonRecord | undefined =>
  path.reduce<JsonRecord | undefined>((node, key) => {
    if (node === undefined) return undefined;
    const next = Predicate.isNumber(key)
      ? (Option.getOrUndefined(decodeArray(node.prefixItems))?.[key] ?? node.items)
      : (Option.getOrUndefined(decodeJsonRecord(node.properties))?.[String(key)] ??
        node.additionalProperties);
    return Option.getOrUndefined(decodeJsonRecord(next));
  }, root);

const declaredTypes = (node: JsonRecord): ReadonlyArray<string> =>
  Predicate.isString(node.type)
    ? [node.type]
    : Option.getOrElse(decodeStrings(node.type), (): ReadonlyArray<string> => []);

/** Whether a node admits integers but not other numbers, which the root checks as numbers. */
const declaresInteger = (node: JsonRecord | undefined): boolean => {
  const types = node === undefined ? [] : declaredTypes(node);
  return types.includes("integer") && !types.includes("number");
};

/**
 * What the schema wanted, in the words a refusal uses. The root checks integers as numbers that
 * are multiples of 1, so a non-number where the schema declares `integer` names an integer.
 */
const problemText = (message: string, integer: boolean): string => {
  if (message === "Missing key") return "required but missing";
  if (message === "Expected no excess property") return "not allowed by the schema";
  if (message === "Expected a value that is a multiple of 1") return "expected an integer";
  if (!message.startsWith("Expected ")) return message;
  const expected = message.slice("Expected ".length);
  return `expected ${integer ? expected.replace(/\bnumber\b/u, "integer") : expected}`;
};

const argsProblems = (
  root: JsonRecord,
  issue: SchemaIssue.Issue,
): ReadonlyArray<WorkflowArgsProblem> =>
  formatIssue(issue).issues.map((entry) => {
    const path = (entry.path ?? []).map(segmentKey);
    const integer = declaresInteger(nodeAt(root, path));
    return {
      path: clipText(pathText(path), ARGS_PATH_MAX_CHARS),
      problem: clipText(problemText(entry.message, integer), ARGS_PROBLEM_MAX_CHARS),
    };
  });

const union = (members: ReadonlyArray<string>): string => members.join(" | ");
const grouped = (text: string): string => (text.includes(" | ") ? `(${text})` : text);

const describesKeys = (node: JsonRecord): boolean =>
  Option.exists(
    decodeJsonRecord(node.properties),
    (properties) => Object.keys(properties).length > 0,
  ) ||
  Option.exists(decodeStrings(node.required), (names) => names.length > 0) ||
  Option.isSome(decodeJsonRecord(node.additionalProperties));
const describesItems = (node: JsonRecord): boolean =>
  node.items !== undefined || node.prefixItems !== undefined;

/**
 * `{ name: T, optional?: T, [key: string]: T }`, with required names the schema doesn't describe
 * as `any`, `{}` for a closed empty object, or plain `object`.
 */
const objectSummary = (node: JsonRecord): string => {
  const properties = Option.getOrElse(decodeJsonRecord(node.properties), (): JsonRecord => ({}));
  const required = new Set(Option.getOrElse(decodeStrings(node.required), () => []));
  const values = decodeJsonRecord(node.additionalProperties);
  const entries = [
    ...Object.entries(properties).map(
      ([key, value]) => `${keyText(key)}${required.has(key) ? "" : "?"}: ${summarize(value)}`,
    ),
    ...[...required]
      .filter((key) => !Object.hasOwn(properties, key))
      .map((key) => `${keyText(key)}: any`),
    ...(Option.isSome(values) ? [`[key: string]: ${summarize(values.value)}`] : []),
  ];
  if (entries.length > 0) return `{ ${entries.join(", ")} }`;
  return node.additionalProperties === false ? "{}" : "object";
};

/** `T[]`, a tuple `[A, B]`, or plain `array`. */
const arraySummary = (node: JsonRecord): string => {
  const tuple = decodeArray(node.prefixItems);
  if (Option.isSome(tuple)) return `[${tuple.value.map(summarize).join(", ")}]`;
  return node.items === undefined ? "array" : `${grouped(summarize(node.items))}[]`;
};

const typeSummary = (node: JsonRecord, type: string): string => {
  if (type === "object") return objectSummary(node);
  if (type === "array") return arraySummary(node);
  return type;
};

/** The values a node lists itself: its constant or enum members. */
const listedValues = (node: JsonRecord): string | undefined => {
  if (node.const !== undefined) return canonicalJsonText(node.const);
  const members = decodeArray(node.enum);
  return Option.isSome(members) ? union(members.value.map(canonicalJsonText)) : undefined;
};

/** What a node's own `type`, keys and items say, without its branches. */
const ownSummary = (node: JsonRecord): string | undefined => {
  const types = declaredTypes(node);
  if (types.length > 0) return union(types.map((type) => typeSummary(node, type)));
  if (describesKeys(node)) return objectSummary(node);
  if (describesItems(node)) return arraySummary(node);
  return undefined;
};

/**
 * The node's `anyOf` or `oneOf` branches as a union, unless one says nothing the summary can show,
 * such as a branch that only lists required keys: the union is then no narrower than the node.
 */
const branchSummary = (node: JsonRecord): string | undefined => {
  const branches = Option.getOrElse(decodeArray(node.anyOf ?? node.oneOf), () => []);
  const members = branches.map(summarize);
  return members.length === 0 || members.includes("any") ? undefined : union(members);
};

/**
 * A compact, TypeScript-like reading of a schema node; `any` where it says nothing checkable. A
 * node's own keys or items win over its branches, which typically only refine them; branches
 * stand in for a node that names at most a type.
 */
function summarize(schema: Schema.Json): string {
  const record = decodeJsonRecord(schema);
  if (Option.isNone(record)) return schema === false ? "never" : "any";
  const node = record.value;
  const listed = listedValues(node);
  if (listed !== undefined) return listed;
  const own = ownSummary(node);
  if (own !== undefined && (describesKeys(node) || describesItems(node))) return own;
  return branchSummary(node) ?? own ?? "any";
}

/** The schema's summary, bounded for listings and refusals. */
export const workflowArgsSummary = (schema: Schema.Json): string =>
  clipText(summarize(schema), WORKFLOW_ARGS_SUMMARY_MAX_CHARS);

/** Compiles `meta.args`; an unusable schema fails with why. */
export const compileWorkflowArgs = (
  schema: Schema.Json,
): Effect.Effect<WorkflowArgsContract, InvalidJsonSchemaError> =>
  Effect.gen(function* () {
    const { root } = yield* checkJsonSchema(schema, "Args");
    const decode = yield* importJsonSchema(root, "Args");
    return {
      summary: workflowArgsSummary(root),
      check: (args) =>
        decode(args).pipe(
          Effect.match({
            onSuccess: (): ReadonlyArray<WorkflowArgsProblem> => [],
            onFailure: (error) => argsProblems(root, error.issue),
          }),
        ),
    } satisfies WorkflowArgsContract;
  });

/** Why args don't match workflow `name`'s schema, naming the first problems and the args it expects. */
const mismatchText = (
  name: string,
  problems: ReadonlyArray<WorkflowArgsProblem>,
  summary: string,
): string => {
  const shown = problems
    .slice(0, ARGS_PROBLEMS_SHOWN)
    .map((entry) => `${entry.path}: ${entry.problem}`);
  const more = problems.length - shown.length;
  return [
    `Args for workflow "${name}" don't match its meta.args schema: ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`,
    `Expected args: ${summary}`,
  ].join("\n");
};

/**
 * Checks args against a script's `meta.args`, if it declares one, for a start or a nested
 * `workflow()` call; a mismatch fails with the first problems and the args the workflow expects.
 */
export const requireWorkflowArgs = (
  contract: WorkflowArgsContract | undefined,
  name: string,
  args: Schema.Json,
): Effect.Effect<void, WorkflowRequestError> =>
  contract === undefined
    ? Effect.void
    : contract
        .check(args)
        .pipe(
          Effect.flatMap((problems) =>
            problems.length === 0
              ? Effect.void
              : Effect.fail(
                  workflowRequestError(
                    "args_mismatch",
                    mismatchText(name, problems, contract.summary),
                    problems,
                  ),
                ),
          ),
        );

/** Checks a start's args: their size as JSON, then the script's `meta.args` schema. */
export const requireStartArgs = (
  contract: WorkflowArgsContract | undefined,
  name: string,
  args: Schema.Json,
): Effect.Effect<void, WorkflowRequestError> =>
  Option.getOrElse(encodeJson(args), () => "").length > WORKFLOW_ARGS_MAX_CHARS
    ? Effect.fail(
        workflowRequestError(
          "args_too_large",
          `Workflow args are limited to ${WORKFLOW_ARGS_MAX_CHARS} characters of JSON; pass file paths for larger inputs.`,
        ),
      )
    : requireWorkflowArgs(contract, name, args);
