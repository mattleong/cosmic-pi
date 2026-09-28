/** The host tool tree: its shape, validation, path lookup, and model-visible descriptions. */
import { ToolRuntimeError } from "./diagnostic.ts";
import { identifierSegment, inputTypeScript, outputTypeScript } from "./tool-schema.ts";
import { isDefinition, type Definition } from "./tool.ts";

export type HostTools<R = never> = {
  readonly [name: string]: Definition<R> | HostTools<R>;
};

type ToolNode<R> = Definition<R> | HostTools<R>;

const isTool = <R>(node: ToolNode<R>): node is Definition<R> => isDefinition(node);

/** Model-visible description of one tool. */
export interface ToolDescription {
  /** Dotted canonical path, such as `pi.read`. */
  readonly path: string;
  /** Exact expression, preserving bracket-only names. */
  readonly callablePath: string;
  readonly description: string;
  readonly signature: string;
}

/** Reserved for Code Mode's own discovery tools. */
export const reservedNamespace = "$codemode";

/** Deepest tool path a host may register. */
const MAX_TOOL_PATH_SEGMENTS = 16;

/** Longest single tool or namespace name. */
const MAX_TOOL_SEGMENT_LENGTH = 128;

/** Names that reach a prototype on any object that has one. */
const blockedNames = new Set(["__proto__", "constructor", "prototype"]);

export const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

export const toolExpression = (path: ReadonlyArray<string>) =>
  "tools" +
  path
    .map((segment) =>
      identifierSegment.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`,
    )
    .join("");

export const describeDefinition = <R>(
  path: ReadonlyArray<string>,
  definition: Definition<R>,
): ToolDescription => ({
  path: path.join("."),
  callablePath: toolExpression(path),
  description: definition.description,
  signature: `${toolExpression(path)}(input: ${inputTypeScript(definition, true)}): Promise<${outputTypeScript(definition, true)}>`,
});

/** Every tool with its path, in tree order. */
export const toolEntries = <R>(
  tools: HostTools<R>,
  prefix: ReadonlyArray<string> = [],
): Array<{ readonly path: ReadonlyArray<string>; readonly definition: Definition<R> }> =>
  Object.entries(tools).flatMap(([name, value]) =>
    isTool(value)
      ? [{ path: [...prefix, name], definition: value }]
      : toolEntries(value, [...prefix, name]),
  );

/** Every tool with its description, sorted by callable path. */
export const visibleDefinitions = <R>(tools: HostTools<R>) =>
  toolEntries(tools)
    .map(({ path, definition }) => ({
      path,
      definition,
      description: describeDefinition(path, definition),
    }))
    .sort((left, right) =>
      compareText(left.description.callablePath, right.description.callablePath),
    );

const clippedToolPath = (path: ReadonlyArray<string>): string => {
  const joined = path.join(".");
  return joined.length <= MAX_TOOL_SEGMENT_LENGTH
    ? joined
    : `${joined.slice(0, MAX_TOOL_SEGMENT_LENGTH)}…`;
};

/**
 * Validates a host tool tree once: plain nested records of tools, no cycles, safe bounded
 * names, and no reserved namespace.
 */
export const assertValidTools = <R>(tools: HostTools<R>): void => {
  if (Object.hasOwn(tools, reservedNamespace)) {
    throw new Error(`Tool namespace '${reservedNamespace}' is reserved for Code Mode discovery.`);
  }
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
      if (name.length === 0 || blockedNames.has(name)) {
        throw new Error(`Tool name ${JSON.stringify(label)} is not allowed.`);
      }
      if (next.length > MAX_TOOL_PATH_SEGMENTS || name.length > MAX_TOOL_SEGMENT_LENGTH) {
        throw new Error(
          `Tool '${clippedToolPath(next)}' exceeds ${MAX_TOOL_PATH_SEGMENTS} names of at most ${MAX_TOOL_SEGMENT_LENGTH} characters.`,
        );
      }
      if (!isTool(value)) visit(value, next);
    }
    ancestors.delete(node);
  };
  visit(tools, []);
};

/** The tool or namespace at `path`, or undefined when the path names nothing. */
const lookupToolPath = <R>(
  tools: HostTools<R>,
  path: ReadonlyArray<string>,
): ToolNode<R> | undefined => {
  let node: ToolNode<R> = tools;
  for (const segment of path) {
    if (blockedNames.has(segment) || isTool(node) || !Object.hasOwn(node, segment))
      return undefined;
    node = node[segment]!;
  }
  return node;
};

/** The callable tool at `path`; an unknown or namespace path fails with suggestions. */
export const resolve = <R>(tools: HostTools<R>, path: ReadonlyArray<string>): Definition<R> => {
  const node = lookupToolPath(tools, path);
  if (node === undefined) {
    const nearest = nearestToolPaths(tools, path);
    throw new ToolRuntimeError(
      "UnknownTool",
      `Unknown tool '${clippedToolPath(path)}'.`,
      [
        ...(nearest.length > 0 ? [`Did you mean ${nearest.join(" or ")}?`] : []),
        "Use tools.$codemode.search({ query }) to find available tools.",
      ],
      { tool: clippedToolPath(path), toolIssue: "unknown" },
    );
  }
  if (isTool(node)) return node;
  throw new ToolRuntimeError("UnknownTool", `Tool '${path.join(".")}' is not callable.`, [], {
    tool: path.join("."),
    toolIssue: "not-callable",
  });
};

/** Whether a path names a namespace of tools. */
export const isNamespacePath = <R>(tools: HostTools<R>, path: ReadonlyArray<string>): boolean => {
  const node = lookupToolPath(tools, path);
  return node !== undefined && !isTool(node);
};

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
export const nearestToolPaths = <R>(tools: HostTools<R>, path: ReadonlyArray<string>) => {
  const wanted = path.join(".");
  const leaf = path[path.length - 1];
  return toolEntries(tools)
    .map(({ path: candidate }) => ({
      candidate,
      distance:
        candidate[candidate.length - 1] === leaf ? 0 : editDistance(wanted, candidate.join("."), 2),
    }))
    .filter(({ distance }) => distance <= 2)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 3)
    .map(({ candidate }) => toolExpression(candidate));
};
