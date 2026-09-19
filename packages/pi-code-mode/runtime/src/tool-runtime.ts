import * as Predicate from "effect/Predicate";
import type { CatalogSnapshot } from "./catalog.js";
import { description as namespaceDescription } from "./namespace.js";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RuntimeFailure } from "./failure.js";
import { runHost, ToolError } from "./tool-error.js";
import { type InterpreterValue, ToolReference } from "./interpreter/model.js";
export { ToolReference } from "./interpreter/model.js";
import {
  decodeInput as decodeToolInput,
  decodeOutput as decodeToolOutput,
  identifierSegment,
  inputProperties,
  inputTypeScript,
  outputTypeScript,
} from "./tool-schema.js";
import { isDefinition as isToolDefinition, type Definition } from "./tool.js";
import { copyArguments, copyIn, isBlockedMember } from "./tool-runtime-data.js";
import { ToolRuntimeError } from "./tool-runtime-error.js";
export {
  copyIn,
  copyOut,
  isBlockedMember,
  type SerializableValue,
  type SerializableArray,
  type SerializableObject,
} from "./tool-runtime-data.js";
export { ToolRuntimeError } from "./tool-runtime-error.js";

const estimateTokens = (input: string) => Math.max(0, Math.round(input.length / 4));
const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Callable host tool leaf. The declared failure channel is the closed `ToolError`; hosts
 * with other failure types normalize through `runHost`/`toolError` (or let failures travel
 * as defects, which the invoke path collapses into a generic `ToolError`).
 */
export type HostTool<R = never> = (...args: Array<unknown>) => Effect.Effect<unknown, ToolError, R>;

export type HostTools<R = never> = {
  [name: string]: HostTool<R> | Definition<R> | HostTools<R>;
};

export type Services<Tools> = ServicesOf<Tools, []>;

type ServicesOf<Tools, Depth extends ReadonlyArray<unknown>> = Depth["length"] extends 8
  ? never
  : Tools extends (...args: Array<unknown>) => Effect.Effect<unknown, unknown, infer R>
    ? R
    : Tools extends {
          readonly _tag: "CodeModeTool";
          readonly run: <Input>(input: Input) => Effect.Effect<unknown, unknown, infer R>;
        }
      ? R
      : Tools extends object
        ? string extends keyof Tools
          ? ServicesOf<Tools[string], [...Depth, unknown]>
          : ServicesOf<Tools[keyof Tools], [...Depth, unknown]>
        : never;

/** Minimal audit record retained for each admitted tool call. */
export type ToolCall = {
  readonly name: string;
};

/** Full lifecycle event for one eagerly forked tool call. */
export type ToolCallLifecycleEvent =
  | {
      readonly id: number;
      readonly name: string;
      readonly status: "queued";
    }
  | {
      readonly id: number;
      readonly name: string;
      readonly status: "running";
      readonly queueDurationMs: number;
    }
  | {
      readonly id: number;
      readonly name: string;
      readonly status: "succeeded" | "failed" | "cancelled";
      /** Whether this call acquired a concurrency permit before terminal settlement. */
      readonly started: boolean;
      /** Wall-clock time from queue admission through terminal settlement. */
      readonly durationMs: number;
      readonly queueDurationMs: number;
    };

/** Decoded tool call observed immediately before tool execution. */
export type ToolCallStarted = {
  readonly index: number;
  /** Correlates this admitted call with `onToolCallLifecycle`, when that hook is enabled. */
  readonly lifecycleId?: number;
  readonly name: string;
  readonly input: unknown;
};

/** Completed tool call observed immediately after tool execution settles. */
export type ToolCallEnded = {
  readonly index: number;
  /** Correlates this admitted call with `onToolCallLifecycle`, when that hook is enabled. */
  readonly lifecycleId?: number;
  readonly name: string;
  readonly input: unknown;
  readonly durationMs: number;
  readonly outcome: "success" | "failure";
  /** Model-safe failure message; present only when `outcome` is `"failure"`. */
  readonly message?: string;
};

/** Non-throwing observation hooks fired around each admitted tool call. */
export type ToolCallHooks<R = never> = {
  readonly onToolCallLifecycle?:
    | ((event: ToolCallLifecycleEvent) => Effect.Effect<void, never, R>)
    | undefined;
  readonly onToolCallStart?: ((call: ToolCallStarted) => Effect.Effect<void, never, R>) | undefined;
  readonly onToolCallEnd?: ((call: ToolCallEnded) => Effect.Effect<void, never, R>) | undefined;
};

/** Model-visible description of one schema-backed tool. */
export type ToolDescription = {
  readonly path: string;
  readonly description: string;
  readonly signature: string;
};

type DescribedTool = ToolDescription & {
  /** Exact expression, preserving literal dots and bracket-only names. */
  readonly callablePath: string;
};

const reservedNamespace = "$codemode";
const defaultCatalogBudget = 2_000;
const defaultSearchLimit = 10;
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const SearchInput = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  namespace: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(PositiveInt),
  offset: Schema.optionalKey(NonNegativeInt),
});
const SearchItem = Schema.Struct({
  path: Schema.String,
  description: Schema.String,
  signature: Schema.String,
});
const SearchOutput = Schema.Struct({
  items: Schema.Array(SearchItem),
  remaining: NonNegativeInt,
  next: Schema.NullOr(Schema.Struct({ offset: NonNegativeInt })),
});
const toolExpression = (path: ReadonlyArray<string>) =>
  "tools" +
  path
    .map((segment) =>
      identifierSegment.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`,
    )
    .join("");

const isDefinition = <R>(
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

const namespaceMetadata = <R>(
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

const ancestorDescriptions = <R>(
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

const describeDefinition = <R>(
  path: ReadonlyArray<string>,
  definition: Definition<R>,
): DescribedTool => ({
  path: path.join("."),
  callablePath: toolExpression(path),
  description: definition.description,
  signature: `${toolExpression(path)}(input: ${inputTypeScript(definition, true)}): Promise<${outputTypeScript(definition, true)}>`,
});

const visibleDefinitions = <R>(tools: HostTools<R>) =>
  definitions(tools)
    .map(({ path, definition }) => ({
      path,
      definition,
      description: describeDefinition(path, definition),
    }))
    .sort((left, right) =>
      compareText(left.description.callablePath, right.description.callablePath),
    );

export type DiscoveryPlan = {
  readonly snapshot: CatalogSnapshot;
  readonly catalog: ReadonlyArray<ToolDescription>;
  readonly instructions: string;
  readonly searchIndex: ReadonlyArray<SearchEntry>;
};

export type SearchEntry = {
  readonly description: DescribedTool;
  /** Top-level namespace (first path segment), matched by the search `namespace` option. */
  readonly namespace: string;
  /** Lowercased path + description + input property names/descriptions, for substring matching. */
  readonly searchText: string;
};

/**
 * Split a query into lowercased search terms. camelCase boundaries are split
 * (`resolveLibrary` -> `resolve library`) and every non-alphanumeric character is a
 * separator, so `resolve-library-id`, `resolveLibraryId`, and `resolve library id` all
 * tokenize alike. Empties and the `*` wildcard are dropped.
 */
const tokenize = (query: string): Array<string> =>
  query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0 && term !== "*");

/**
 * A term plus its naive singular variants (trailing "s"/"es" stripped), so a plural
 * query term ("issues") still matches indexed text that only carries the singular
 * ("issue"). Matching is one-directional substring containment, so the variants are
 * needed only on the query side; scoring weights are unchanged - each field check
 * passes when ANY form matches.
 */
const termForms = (term: string): Array<string> => {
  const forms = [term];
  if (term.endsWith("es") && term.length > 3) forms.push(term.slice(0, -2));
  if (term.endsWith("s") && term.length > 2) forms.push(term.slice(0, -1));
  return forms;
};

const makeSearchTool = (searchIndex: ReadonlyArray<SearchEntry>): Definition => ({
  _tag: "CodeModeTool",
  description: "Search available Code Mode tools",
  input: SearchInput,
  output: SearchOutput,
  run: (input) =>
    Effect.sync(() => {
      // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
      const request = input as typeof SearchInput.Type;
      const query = request.query ?? "";
      const offset = request.offset ?? 0;
      const scoped =
        request.namespace === undefined
          ? searchIndex
          : searchIndex.filter((entry) => entry.namespace === request.namespace);
      // A query that names one tool path exactly (canonical path or rendered JavaScript
      // expression) is a lookup, not a search: return that tool alone.
      const trimmed = query.trim();
      const pathQuery = trimmed.startsWith("tools.") ? trimmed.slice("tools.".length) : trimmed;
      const exact =
        pathQuery === ""
          ? undefined
          : (scoped.find((entry) => entry.description.callablePath === trimmed) ??
            scoped.find((entry) => entry.description.path === pathQuery));
      const terms = tokenize(query).map(termForms);
      // Additive field-weighted scoring, summed across terms: exact path or path segment
      // (20) > path substring (8) > description substring (4) > any searchable text,
      // including input parameter names and descriptions (2).
      const ranked =
        exact !== undefined
          ? [exact]
          : scoped
              .map((entry) => {
                const path = entry.description.path.toLowerCase();
                const description = entry.description.description.toLowerCase();
                const score = terms.reduce(
                  (total, forms) =>
                    total +
                    (forms.some((form) => path === form || path.endsWith(`.${form}`)) ? 20 : 0) +
                    (forms.some((form) => path.includes(form)) ? 8 : 0) +
                    (forms.some((form) => description.includes(form)) ? 4 : 0) +
                    (forms.some((form) => entry.searchText.includes(form)) ? 2 : 0),
                  0,
                );
                return { entry, score };
              })
              .filter(({ score }) => terms.length === 0 || score > 0)
              .sort(
                (left, right) =>
                  right.score - left.score ||
                  compareText(
                    left.entry.description.callablePath,
                    right.entry.description.callablePath,
                  ),
              )
              .map(({ entry }) => entry);
      const items = ranked
        .slice(offset, offset + (request.limit ?? defaultSearchLimit))
        .map(({ description }) => ({
          path: description.callablePath,
          description: description.description,
          signature: description.signature,
        }));
      const remaining = Math.max(0, ranked.length - offset - items.length);
      return {
        items,
        remaining,
        next: remaining > 0 ? { offset: offset + items.length } : null,
      };
    }),
});

const searchDescription = describeDefinition([reservedNamespace, "search"], makeSearchTool([]));

const catalogDescription = (tool: ToolDescription) => {
  const line = tool.description.split("\n", 1)[0]!.trim();
  return line.length > 120 ? line.slice(0, 119) + "..." : line;
};

const catalogLine = (tool: ToolDescription) => {
  const description = catalogDescription(tool);
  return description === "" ? `  - ${tool.signature}` : `  - ${tool.signature} // ${description}`;
};

const toSearchEntry = <R>(
  path: ReadonlyArray<string>,
  definition: Definition<R>,
  description: DescribedTool,
  namespaceDescriptions: ReadonlyArray<string> = [],
): SearchEntry => ({
  description,
  namespace: path[0]!,
  searchText: [
    path.join("."),
    definition.description,
    ...namespaceDescriptions,
    ...inputProperties(definition).flatMap(({ name, description: property }) =>
      property === undefined ? [name] : [name, property],
    ),
  ]
    .join("\n")
    .toLowerCase(),
});

/** The runtime search index over every described tool. Search is always registered. */
export const searchIndex = <R>(tools: HostTools<R>): ReadonlyArray<SearchEntry> =>
  visibleDefinitions(tools).map(({ path, definition, description }) =>
    toSearchEntry(path, definition, description, ancestorDescriptions(tools, path)),
  );

export const assertValidTools = <R>(tools: HostTools<R>): void => {
  if (Object.hasOwn(tools, reservedNamespace)) {
    throw new Error(
      `Tool namespace '${reservedNamespace}' is reserved for CodeMode discovery tools.`,
    );
  }
};

/**
 * Budgeted catalog: every namespace is always listed with its tool count; full call
 * signatures are inlined against the `catalogBudget` (estimated tokens,
 * chars/4) round-robin across namespaces - in each round (namespaces alphabetical), every
 * namespace still holding un-inlined tools attempts to place its next-cheapest line, and
 * a namespace whose next line does not fit is done while the others keep going - so every
 * namespace gets some representation before any namespace gets everything. The section
 * states exactly how comprehensive it is - overall (COMPLETE vs PARTIAL) and per
 * namespace. Namespace stub lines are never budgeted: every namespace appears with its
 * tool count even at budget 0.
 */
export const prepare = <R>(
  tools: HostTools<R>,
  catalogBudget = defaultCatalogBudget,
): DiscoveryPlan => {
  if (!Number.isSafeInteger(catalogBudget) || catalogBudget < 0) {
    throw new RangeError("discovery.catalogBudget must be a non-negative safe integer");
  }
  const visible = visibleDefinitions(tools);
  const described = visible.map(({ description }) => description);

  const metadata = namespaceMetadata(tools).sort((left, right) =>
    compareText(toolExpression(left.path), toolExpression(right.path)),
  );
  const namespaces = new Map<string, Array<DescribedTool>>();
  for (const { path } of metadata) if (path.length === 1) namespaces.set(path[0]!, []);
  for (const { path, description: tool } of visible) {
    const namespace = path[0]!;
    const group = namespaces.get(namespace) ?? [];
    group.push(tool);
    namespaces.set(namespace, group);
  }
  const ordered = [...namespaces].sort(([left], [right]) => compareText(left, right));

  // Select which signatures fit the budget before emitting, so the list can state
  // exactly how comprehensive it is. Round-robin fairness: in each round (namespaces
  // alphabetical), every namespace still holding un-inlined tools tries to place its
  // next-cheapest line against the shared budget; a namespace whose next line does not
  // fit is done - the others keep going - so every namespace gets some representation
  // before any namespace gets everything.
  const selections = ordered.map(([namespace, group]) => ({
    namespace,
    picked: new Set<DescribedTool>(),
    queue: [...group].sort(
      (left, right) =>
        estimateTokens(catalogLine(left)) - estimateTokens(catalogLine(right)) ||
        compareText(left.callablePath, right.callablePath),
    ),
  }));
  let used = 0;
  let active = selections.filter((selection) => selection.queue.length > 0);
  while (active.length > 0) {
    const stillActive: typeof active = [];
    for (const selection of active) {
      const tool = selection.queue[0]!;
      const cost = estimateTokens(catalogLine(tool));
      if (used + cost > catalogBudget) continue;
      selection.queue.shift();
      selection.picked.add(tool);
      used += cost;
      if (selection.queue.length > 0) stillActive.push(selection);
    }
    active = stillActive;
  }
  const shown = new Map<string, ReadonlySet<DescribedTool>>(
    selections.map(({ namespace, picked }) => [namespace, picked]),
  );
  const totalShown = selections.reduce((total, { picked }) => total + picked.size, 0);
  const complete = totalShown === described.length;

  // Descriptions consume only the remaining budget, never displacing callable signatures.
  const namespaceLines: Array<string> = [];
  const namespaceDescriptions: Array<{ readonly path: string; readonly description: string }> = [];
  for (const { path, description } of metadata) {
    if (description === undefined || description.trim() === "") continue;
    const summary = catalogDescription({ path: "", signature: "", description })
      .replaceAll("*/", "* /")
      .replace(/[\r\n\u2028\u2029]/g, " ");
    const line = `  // ${toolExpression(path)}: ${summary}`;
    const cost = estimateTokens(line);
    if (used + cost > catalogBudget) continue;
    used += cost;
    namespaceLines.push(line);
    namespaceDescriptions.push(Object.freeze({ path: toolExpression(path), description: summary }));
  }
  const empty = described.length === 0 && ordered.length === 0;

  // Section order is deliberate: workflow first (the top is the least likely part of a long
  // description to be truncated or skimmed away), then rules, then syntax, with the budgeted
  // catalog at the bottom. Example call forms use placeholders - never a real or fabricated
  // tool name - and show both dot and bracket notation so non-identifier names are not normalized.
  const intro = [
    empty
      ? "This is a restricted JavaScript language for calling tools, not a general-purpose runtime."
      : complete
        ? "This is a restricted JavaScript language for calling tools, not a general-purpose runtime. Inside the confined interpreter, `tools` contains the Code Mode tools listed below and internal runtime tools; surrounding agent tools are not available."
        : "This is a restricted JavaScript language for calling tools, not a general-purpose runtime. Inside the confined interpreter, `tools` contains the Code Mode tools listed or searchable below and internal runtime tools; surrounding agent tools are not available.",
    ...(empty
      ? []
      : [
          "Do not infer or normalize tool names; use only exact signatures shown below or returned by search.",
        ]),
  ];

  // The search step exists only when search is advertised (PARTIAL catalog); a COMPLETE
  // catalog already shows every signature, so step 1 picks from the list instead.
  const workflow = empty
    ? []
    : [
        "",
        "## Workflow",
        "",
        ...(complete
          ? [
              "1. Pick a tool from the list under `## Available tools` - each line is the exact call signature; use it as-is rather than guessing segments.",
              "2. Call it using the exact signature shown: `const result = await tools.<namespace>.<tool>(input)`; bracket notation and quotes are part of the path.",
              "3. Return only the fields you need from structured results; narrow unknown results before reading fields, and avoid returning large raw payloads.",
            ]
          : [
              '1. If needed, discover tools: `return await tools.$codemode.search({ query: "<intent + key nouns>" })`.',
              "2. In the next execution, copy a returned path exactly, call it, and return only the needed fields.",
            ]),
      ];

  const rules = empty
    ? []
    : [
        "",
        "## Rules",
        "",
        complete
          ? "- Only Code Mode tools listed here and internal runtime tools are available; surrounding agent tools are not implicitly exposed."
          : "- Only Code Mode tools listed here or returned by `tools.$codemode.search` and internal runtime tools are available; surrounding agent tools are not implicitly exposed.",
        "- Filter, aggregate, and transform collections in code when that preserves the evidence needed for the next decision. Batch already-known work; inspect results before choosing actions that require judgment.",
        "- A result typed `Promise<unknown>` may be structured data or text. Before reading fields, check that it is a non-null object and not an array; otherwise handle the returned text or primitive directly.",
        '- Run independent calls in parallel: `await Promise.all(items.map((item) => tools.<namespace>.<tool>(item)))`, or use `tools.<namespace>["tool-name"](item)` when the listed signature uses bracket notation.',
        "- `Object.keys(tools)` lists namespaces; `Object.keys(tools.<namespace>)` lists its tools; `for...in` works on both.",
        ...(complete
          ? []
          : [
              '- Browse one namespace: `await tools.$codemode.search({ query: "", namespace: "<name>" })`.',
              "- If search returns `next`, repeat the same search with `offset: next.offset`.",
            ]),
      ];

  const language = [
    "",
    "## Language",
    "",
    "Use common JavaScript data operations, functions, control flow, selected standard-library methods, and awaited tool calls. Destructuring declarations and assignments support computed keys. Built-ins include Date, RegExp, Map, Set, URL, URLSearchParams, and URI encoding helpers.",
    "Bounded Uint8Array supports indexed mutation, iteration, at/slice/subarray/set, fromBase64/fromHex and toBase64/toHex. TextEncoder/TextDecoder support UTF-8 only; TextDecoder accepts boolean fatal/ignoreBOM flags. atob/btoa and byte codecs require standard canonical padded base64 without whitespace; hex requires complete byte pairs. ArrayBuffer, streaming and base64/hex options are unavailable. Encode bytes as text before returning them or passing them to tools; raw bytes are refused, including inside arrays and records.",
    "Synchronous guest call ancestry is capped at 128 with a catchable RangeError. Genuine async continuation boundaries reset depth; async calls before their first await and nested generator resumes still count.",
    "Async functions, sync and async generators, guest Symbol.iterator/Symbol.asyncIterator protocols, for-await loops, labeled control flow, promise chaining, Promise.any, grouping helpers, and JSON replacers/revivers are supported. Set union/intersection/difference/symmetricDifference and isSubsetOf/isSupersetOf/isDisjointFrom accept Set or Map operands. Callbacks accept supported builtin references such as .map(JSON.stringify); wrap single-input tools in arrow functions to avoid extra callback arguments. Grouping and JSON callbacks are not implicitly awaited. Modules/imports, classes, timers, fetch, eval, prototype access, and unlisted methods are unavailable. Use Code Mode tools for external operations.",
    "For literal keyword filtering, prefer `terms.some(term => line.includes(term))` over regex alternation; conservative regex guards reject some safe patterns. Backslashes in string patterns must survive JavaScript string escaping.",
    "Dates and URLs serialize to strings at data boundaries; Map/Set/RegExp/URLSearchParams serialize to `{}`.",
  ];

  const toolSection: Array<string> = [""];
  if (empty) {
    toolSection.push("## Available tools", "", "No tools are currently available.");
  } else {
    toolSection.push(
      complete
        ? "## Available tools (COMPLETE list - every tool is shown below with its full call signature)"
        : `## Available tools (PARTIAL - ${totalShown} of ${described.length} shown; find the rest with tools.$codemode.search)`,
      "",
    );
    for (const [namespace, group] of ordered) {
      const picked = shown.get(namespace)!;
      const count = `${group.length} tool${group.length === 1 ? "" : "s"}`;
      // Annotate only when a namespace is not fully shown, so a comprehensive
      // namespace reads cleanly and a truncated one is unambiguous.
      const label =
        picked.size === group.length
          ? count
          : picked.size === 0
            ? `${count}, none shown`
            : `${count}, ${picked.size} shown`;
      toolSection.push(`- ${namespace} (${label})`);
      for (const tool of group) if (picked.has(tool)) toolSection.push(catalogLine(tool));
    }
    toolSection.push(...namespaceLines);
    if (!complete) {
      toolSection.push(
        "",
        "Search returns complete callable signatures:",
        `- ${searchDescription.signature}`,
      );
    }
  }

  const lines = [...intro, ...workflow, ...rules, ...language, ...toolSection];
  return {
    catalog: described.map(({ path, description, signature }) => ({
      path,
      description,
      signature,
    })),
    snapshot: Object.freeze({
      complete,
      namespacePaths: Object.freeze(metadata.map(({ path }) => toolExpression(path))),
      namespaceDescriptions: Object.freeze(namespaceDescriptions),
      namespaces: Object.freeze(
        ordered.map(([name, group]) => Object.freeze({ name, total: group.length })),
      ),
      entries: Object.freeze(
        described
          .filter((tool) => selections.some(({ picked }) => picked.has(tool)))
          .map((tool) =>
            Object.freeze({
              path: tool.callablePath,
              signature: tool.signature,
              description: catalogDescription(tool),
            }),
          ),
      ),
      instructions: lines.join("\n"),
    }),
    instructions: lines.join("\n"),
    searchIndex: visible.map(({ path, definition, description }) =>
      toSearchEntry(path, definition, description, ancestorDescriptions(tools, path)),
    ),
  };
};

/**
 * The enumerable names at one node of the callable tool tree - namespace names at the root,
 * tool/namespace names below - powering `Object.keys(tools)` and `for...in` over tool
 * references. A callable tool is a leaf and enumerates as `[]` (like `Object.keys` of a
 * function in JS). An unknown path is an `UnknownTool` error pointing at the working
 * discovery idioms, mirroring how calling an unknown tool fails.
 */
const namespaceKeys = <R>(
  tools: HostTools<R>,
  path: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  let value: HostTool<R> | Definition<R> | HostTools<R> = tools;
  for (const segment of path) {
    if (
      isBlockedMember(segment) ||
      Predicate.isFunction(value) ||
      isDefinition(value) ||
      !Object.hasOwn(value, segment)
    ) {
      throw new ToolRuntimeError("UnknownTool", `Unknown tool namespace '${path.join(".")}'.`, [
        "Object.keys(tools) lists the available namespaces; tools.$codemode.search({ query }) finds described tools.",
      ]);
    }
    // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
    value = value[segment] as HostTool<R> | Definition<R> | HostTools<R>;
  }
  if (Predicate.isFunction(value) || isDefinition(value)) return [];
  return Object.keys(value);
};

const resolve = <R>(
  tools: HostTools<R>,
  path: ReadonlyArray<string>,
): HostTool<R> | Definition<R> => {
  let value: HostTool<R> | Definition<R> | HostTools<R> = tools;

  for (const segment of path) {
    if (
      isBlockedMember(segment) ||
      Predicate.isFunction(value) ||
      isDefinition(value) ||
      !Object.hasOwn(value, segment)
    ) {
      throw new ToolRuntimeError("UnknownTool", `Unknown tool '${path.join(".")}'.`, [
        "Use tools.$codemode.search({ query }) to find available described tools.",
      ]);
    }
    // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
    value = value[segment] as HostTool<R> | Definition<R> | HostTools<R>;
  }

  if (isDefinition(value)) return value;
  if (Predicate.isFunction(value)) {
    // SAFETY: HostTools permits callable leaves only as HostTool values.
    return value as HostTool<R>;
  }
  throw new ToolRuntimeError("UnknownTool", `Tool '${path.join(".")}' is not callable.`);
};

export type ToolRuntime<R = never> = {
  readonly root: ToolReference;
  readonly calls: Array<ToolCall>;
  readonly invoke: (
    path: ReadonlyArray<string>,
    args: ReadonlyArray<InterpreterValue>,
    lifecycleId?: number,
  ) => Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  /** Enumerable namespace/tool names at one node of the callable tool tree; see `namespaceKeys`. */
  readonly keys: (path: ReadonlyArray<string>) => ReadonlyArray<string>;
};

export const make = <R>(
  tools: HostTools<R>,
  /** Undefined means unlimited tool calls. */
  maxToolCalls: number | undefined,
  searchIndex: ReadonlyArray<SearchEntry>,
  hooks?: ToolCallHooks<R>,
): ToolRuntime<R> => {
  const calls: Array<ToolCall> = [];
  const callableTools = {
    ...tools,
    [reservedNamespace]: { search: makeSearchTool(searchIndex) },
  };

  // Wraps the settling portion of a tool call so onToolCallEnd observes success and failure
  // symmetrically. Interruption (e.g. the execution timeout) fires neither outcome.
  const observeEnd = <A, E>(
    effect: Effect.Effect<A, E, R>,
    call: ToolCallStarted,
  ): Effect.Effect<A, E, R> => {
    const onEnd = hooks?.onToolCallEnd;
    if (onEnd === undefined) return effect;
    return Effect.flatMap(Clock.currentTimeMillis, (startedAt) =>
      effect.pipe(
        Effect.tap(() =>
          Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
            onEnd({ ...call, durationMs: endedAt - startedAt, outcome: "success" }),
          ),
        ),
        Effect.tapError((error) => {
          const message =
            error instanceof ToolError || error instanceof ToolRuntimeError
              ? error.message
              : "Tool execution failed";
          return Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
            onEnd({
              ...call,
              durationMs: endedAt - startedAt,
              outcome: "failure",
              message,
            }),
          );
        }),
      ),
    );
  };

  const decodeOutput = <Value>(value: Value, name: string) =>
    Effect.try({
      try: () => copyIn(value, `Result from tool '${name}'`),
      catch: () => new ToolRuntimeError("InvalidToolOutput", `Invalid output from tool '${name}'.`),
    });

  const recordCall = (call: ToolCall): void => {
    if (maxToolCalls !== undefined && calls.length >= maxToolCalls) {
      throw new ToolRuntimeError(
        "ToolCallLimitExceeded",
        `Execution exceeded its tool-call limit of ${maxToolCalls}.`,
      );
    }
    calls.push(call);
  };

  return {
    root: new ToolReference([]),
    calls,
    keys: (path) => namespaceKeys(callableTools, path),
    invoke: (path, args, lifecycleId) =>
      Effect.gen(function* () {
        const name = path.join(".");
        const externalArgs = copyArguments(args, `Arguments for tool '${name}'`);
        const call = { name };
        const recordAndObserve = <Input>(input: Input) =>
          Effect.sync(() => {
            recordCall(call);
            return calls.length - 1;
          }).pipe(
            Effect.tap((index) => {
              const call = { index, name, input };
              return (
                hooks?.onToolCallStart?.(
                  lifecycleId === undefined ? call : { ...call, lifecycleId },
                ) ?? Effect.void
              );
            }),
          );
        const tool = resolve(callableTools, path);
        let describedInput: unknown;
        if (isDefinition(tool)) {
          if (externalArgs.length !== 1)
            throw new ToolRuntimeError(
              "InvalidToolInput",
              `Tool '${name}' expects exactly one input object.`,
            );
          describedInput = yield* Effect.try({
            try: () => decodeToolInput(tool, externalArgs[0]),
            catch: (cause) =>
              new ToolRuntimeError(
                "InvalidToolInput",
                `Invalid input for tool '${name}': ${String(cause)}`,
              ),
          });
        }
        const input = isDefinition(tool) ? describedInput : externalArgs;
        const index = yield* recordAndObserve(input);
        const baseCall = { index, name, input };
        const currentCall = lifecycleId === undefined ? baseCall : { ...baseCall, lifecycleId };
        if (isDefinition(tool)) {
          return yield* observeEnd(
            Effect.gen(function* () {
              const raw = yield* runHost(Effect.suspend(() => tool.run(describedInput)));
              const result = yield* Effect.try({
                try: () => decodeToolOutput(tool, raw),
                catch: () =>
                  new ToolRuntimeError("InvalidToolOutput", `Invalid output from tool '${name}'.`),
              });
              return yield* decodeOutput(result, name);
            }),
            currentCall,
          );
        }
        return yield* observeEnd(
          Effect.gen(function* () {
            return yield* decodeOutput(
              yield* runHost(Effect.suspend(() => tool(...externalArgs))),
              name,
            );
          }),
          currentCall,
        );
      }),
  };
};

export * as ToolRuntime from "./tool-runtime.js";
