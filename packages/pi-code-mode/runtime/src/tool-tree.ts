/** The host tool tree: its shape, validation, path lookup, and model-visible descriptions. */
import * as Predicate from "effect/Predicate";
import { description as namespaceDescription } from "./namespace.js";
import { ToolRuntimeError } from "./tool-runtime-error.js";
import { isBlockedMember } from "./tool-runtime-data.js";
import { identifierSegment, inputTypeScript, outputTypeScript } from "./tool-schema.js";
import { isDefinition as isToolDefinition, type Definition } from "./tool.js";
import type { ToolError } from "./tool-error.js";
import type * as Effect from "effect/Effect";

export const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Callable host tool leaf. The declared failure channel is the closed `ToolError`; hosts
 * with other failure types normalize through `runHost`/`toolError` (or let failures travel
 * as defects, which the invoke path collapses into a generic `ToolError`).
 */
export type HostTool<R = never> = (...args: Array<unknown>) => Effect.Effect<unknown, ToolError, R>;

export type HostTools<R = never> = {
  [name: string]: HostTool<R> | Definition<R> | HostTools<R>;
};

/** Model-visible description of one schema-backed tool. */
export type ToolDescription = {
  readonly path: string;
  readonly description: string;
  readonly signature: string;
};

export type DescribedTool = ToolDescription & {
  /** Exact expression, preserving literal dots and bracket-only names. */
  readonly callablePath: string;
};

export const reservedNamespace = "$codemode";

export const toolExpression = (path: ReadonlyArray<string>) =>
  "tools" +
  path
    .map((segment) =>
      identifierSegment.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`,
    )
    .join("");

export const isDefinition = <R>(
  value: HostTool<R> | Definition<R> | HostTools<R>,
): value is Definition<R> => isToolDefinition<R>(value);

const definitions = <R>(
  tools: HostTools<R>,
  path: ReadonlyArray<string> = [],
): Array<{ path: ReadonlyArray<string>; definition: Definition<R> }> => {
  const entries: Array<{ path: ReadonlyArray<string>; definition: Definition<R> }> = [];
  for (const [name, value] of Object.entries(tools)) {
    const next = [...path, name];
    if (isDefinition(value)) entries.push({ path: next, definition: value });
    else if (!Predicate.isFunction(value)) entries.push(...definitions(value, next));
  }
  return entries;
};

export const namespaceMetadata = <R>(
  tools: HostTools<R>,
  path: ReadonlyArray<string> = [],
): Array<{
  path: ReadonlyArray<string>;
  description: string | undefined;
}> =>
  Object.entries(tools).flatMap(([name, value]) => {
    if (isDefinition(value) || Predicate.isFunction(value)) return [];
    const next = [...path, name];
    return [
      { path: next, description: namespaceDescription(value) },
      ...namespaceMetadata(value, next),
    ];
  });

export const ancestorDescriptions = <R>(
  tools: HostTools<R>,
  path: ReadonlyArray<string>,
): Array<string> => {
  const descriptions: Array<string> = [];
  let node = tools;
  for (const segment of path.slice(0, -1)) {
    const child = node[segment];
    if (child === undefined || isDefinition(child) || Predicate.isFunction(child)) break;
    node = child;
    const description = namespaceDescription(node);
    if (description !== undefined) descriptions.push(description);
  }
  return descriptions;
};

export const describeDefinition = <R>(
  path: ReadonlyArray<string>,
  definition: Definition<R>,
): DescribedTool => ({
  path: path.join("."),
  callablePath: toolExpression(path),
  description: definition.description,
  signature: `${toolExpression(path)}(input: ${inputTypeScript(definition, true)}): Promise<${outputTypeScript(definition, true)}>`,
});

export const visibleDefinitions = <R>(tools: HostTools<R>) =>
  definitions(tools)
    .map(({ path, definition }) => ({
      path,
      definition,
      description: describeDefinition(path, definition),
    }))
    .sort((left, right) =>
      compareText(left.description.callablePath, right.description.callablePath),
    );

/** Deepest tool path a host may register or a program may spell. */
export const MAX_TOOL_PATH_SEGMENTS = 16;

/** Longest single tool or namespace name. */
export const MAX_TOOL_SEGMENT_LENGTH = 128;

const clippedToolPath = (path: ReadonlyArray<string>): string => {
  const joined = path.join(".");
  return joined.length <= MAX_TOOL_SEGMENT_LENGTH
    ? joined
    : `${joined.slice(0, MAX_TOOL_SEGMENT_LENGTH)}…`;
};

/**
 * Extends a guest tool path by one member. No registered tool is deeper or longer than the
 * limits above, so a path past them is refused before it can grow without bound.
 */
export const extendToolPath = (
  path: ReadonlyArray<string>,
  segment: string,
): ReadonlyArray<string> => {
  const next = [...path, segment];
  if (next.length > MAX_TOOL_PATH_SEGMENTS || segment.length > MAX_TOOL_SEGMENT_LENGTH) {
    throw new ToolRuntimeError(
      "UnknownTool",
      `Unknown tool '${clippedToolPath(next)}': tool paths have at most ${MAX_TOOL_PATH_SEGMENTS} names of at most ${MAX_TOOL_SEGMENT_LENGTH} characters.`,
      ["Use tools.$codemode.search({ query }) to find available described tools."],
      { tool: clippedToolPath(next), toolIssue: "unknown" },
    );
  }
  return next;
};

/**
 * Validates a host tool tree once: plain nested records of tools, no cycles, safe bounded
 * names, and no two tools sharing a dotted name.
 */
export const assertValidTools = <R>(tools: HostTools<R>): void => {
  if (Object.hasOwn(tools, reservedNamespace)) {
    throw new Error(
      `Tool namespace '${reservedNamespace}' is reserved for CodeMode discovery tools.`,
    );
  }
  const names = new Set<string>();
  const ancestors = new Set<HostTools<R>>();
  const visit = (node: HostTools<R>, path: ReadonlyArray<string>): void => {
    const prototype = Object.getPrototypeOf(node);
    if (prototype !== null && prototype !== Object.prototype) {
      throw new Error(`Tool namespace '${path.join(".") || "tools"}' must be a plain object.`);
    }
    if (ancestors.has(node)) throw new Error(`Tool namespace '${path.join(".")}' is cyclic.`);
    ancestors.add(node);
    for (const [name, value] of Object.entries(node)) {
      const next = [...path, name];
      const label = next.join(".");
      if (name.length === 0 || isBlockedMember(name)) {
        throw new Error(`Tool name ${JSON.stringify(label)} is not allowed.`);
      }
      if (next.length > MAX_TOOL_PATH_SEGMENTS || name.length > MAX_TOOL_SEGMENT_LENGTH) {
        throw new Error(
          `Tool '${clippedToolPath(next)}' exceeds ${MAX_TOOL_PATH_SEGMENTS} names of at most ${MAX_TOOL_SEGMENT_LENGTH} characters.`,
        );
      }
      if (isDefinition(value) || Predicate.isFunction(value)) {
        if (names.has(label)) throw new Error(`Two tools share the name '${label}'.`);
        names.add(label);
      } else if (Predicate.isObjectOrArray(value)) {
        visit(value, next);
      } else {
        throw new Error(`Tool '${label}' must be a tool definition or a namespace object.`);
      }
    }
    ancestors.delete(node);
  };
  visit(tools, []);
};

type ToolNode<R> = HostTool<R> | Definition<R> | HostTools<R>;

/** The tool or namespace at `path`, or undefined when the path names nothing. */
const lookupToolPath = <R>(
  tools: HostTools<R>,
  path: ReadonlyArray<string>,
): ToolNode<R> | undefined => {
  let node: ToolNode<R> = tools;
  for (const segment of path) {
    if (
      isBlockedMember(segment) ||
      Predicate.isFunction(node) ||
      isDefinition(node) ||
      !Object.hasOwn(node, segment)
    )
      return undefined;
    // SAFETY: A namespace's own members are tools or nested namespaces (see assertValidTools).
    node = node[segment] as ToolNode<R>;
  }
  return node;
};

const isToolLeaf = <R>(node: ToolNode<R>): node is HostTool<R> | Definition<R> =>
  Predicate.isFunction(node) || isDefinition(node);

/**
 * The enumerable names at one node of the callable tool tree - namespace names at the root,
 * tool/namespace names below - powering `Object.keys(tools)` and `for...in` over tool
 * references. A callable tool is a leaf and enumerates as `[]` (like `Object.keys` of a
 * function in JS). An unknown path is an `UnknownTool` error pointing at the working
 * discovery idioms, mirroring how calling an unknown tool fails.
 */
export const namespaceKeys = <R>(
  tools: HostTools<R>,
  path: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const node = lookupToolPath(tools, path);
  if (node === undefined)
    throw new ToolRuntimeError(
      "UnknownTool",
      `Unknown tool namespace '${path.join(".")}'.`,
      [
        "Object.keys(tools) lists the available namespaces; tools.$codemode.search({ query }) finds described tools.",
      ],
      { tool: path.join("."), toolIssue: "namespace" },
    );
  return isToolLeaf(node) ? [] : Object.keys(node);
};

/** What a tool path names: a callable tool, a namespace of tools, or nothing. */
export type ToolPathKind = "tool" | "namespace" | undefined;

export const toolPathKind = <R>(tools: HostTools<R>, path: ReadonlyArray<string>): ToolPathKind => {
  const node = lookupToolPath(tools, path);
  return node === undefined ? undefined : isToolLeaf(node) ? "tool" : "namespace";
};

/** The callable tool at `path`; an unknown or namespace path fails with suggestions. */
export const resolve = <R>(
  tools: HostTools<R>,
  path: ReadonlyArray<string>,
): HostTool<R> | Definition<R> => {
  const node = lookupToolPath(tools, path);
  if (node === undefined) {
    const nearest = nearestToolPaths(tools, path);
    throw new ToolRuntimeError(
      "UnknownTool",
      `Unknown tool '${path.join(".")}'.`,
      [
        ...(nearest.length > 0 ? [`Did you mean ${nearest.join(" or ")}?`] : []),
        "Use tools.$codemode.search({ query }) to find available described tools.",
      ],
      { tool: path.join("."), toolIssue: "unknown" },
    );
  }
  if (isToolLeaf(node)) return node;
  throw new ToolRuntimeError("UnknownTool", `Tool '${path.join(".")}' is not callable.`, [], {
    tool: path.join("."),
    toolIssue: "not-callable",
  });
};

/** Every callable path in a tool tree. */
const toolPaths = <R>(
  tools: HostTools<R>,
  prefix: ReadonlyArray<string> = [],
): Array<ReadonlyArray<string>> =>
  Object.entries(tools).flatMap(([name, value]) =>
    isDefinition(value) || Predicate.isFunction(value)
      ? [[...prefix, name]]
      : toolPaths(value, [...prefix, name]),
  );

/** Levenshtein distance, abandoned once every path exceeds `limit`. */
const editDistance = (left: string, right: string, limit: number): number => {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++)
      current[column] = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    if (Math.min(...current) > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length]!;
};

/** Registered tools a mistyped path most likely meant: the same tool name, or a near spelling. */
const nearestToolPaths = <R>(tools: HostTools<R>, path: ReadonlyArray<string>) => {
  const wanted = path.join(".");
  const leaf = path[path.length - 1];
  return toolPaths(tools)
    .map((candidate) => ({
      candidate,
      distance:
        candidate[candidate.length - 1] === leaf ? 0 : editDistance(wanted, candidate.join("."), 2),
    }))
    .filter(({ distance }) => distance <= 2)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 3)
    .map(({ candidate }) => toolExpression(candidate));
};
