/** The budgeted tool catalog and the model-facing instructions built from it. */
import type { CatalogSnapshot } from "./catalog.js";
import { type SearchEntry, searchDescription, toSearchEntry } from "./tool-search.js";
import {
  ancestorDescriptions,
  compareText,
  type DescribedTool,
  type HostTools,
  namespaceMetadata,
  type ToolDescription,
  toolExpression,
  visibleDefinitions,
} from "./tool-tree.js";

const estimateTokens = (input: string) => Math.max(0, Math.round(input.length / 4));

const defaultCatalogBudget = 2_000;

export type DiscoveryPlan = {
  readonly snapshot: CatalogSnapshot;
  readonly catalog: ReadonlyArray<ToolDescription>;
  readonly instructions: string;
  readonly searchIndex: ReadonlyArray<SearchEntry>;
};

const catalogDescription = (tool: ToolDescription) => {
  const line = tool.description.split("\n", 1)[0]!.trim();
  return line.length > 120 ? line.slice(0, 119) + "..." : line;
};

const catalogLine = (tool: ToolDescription) => {
  const description = catalogDescription(tool);
  return description === "" ? `  - ${tool.signature}` : `  - ${tool.signature} // ${description}`;
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
