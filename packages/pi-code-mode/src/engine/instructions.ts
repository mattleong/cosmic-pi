/** The budgeted tool catalog and the model-facing instructions built from it. */
import { searchDescription } from "./tool-search.ts";
import {
  compareText,
  type HostTools,
  type ToolDescription,
  visibleDefinitions,
} from "./tool-tree.ts";

const estimateTokens = (input: string) => Math.max(0, Math.round(input.length / 4));

const catalogDescription = (tool: ToolDescription) => {
  const line = tool.description.split("\n", 1)[0]!.trim();
  return line.length > 120 ? line.slice(0, 119) + "..." : line;
};

const catalogLine = (tool: ToolDescription) => {
  const description = catalogDescription(tool);
  return description === "" ? `  - ${tool.signature}` : `  - ${tool.signature} // ${description}`;
};

const LANGUAGE = [
  "",
  "## Language",
  "",
  "The program is the body of an async function run in a fresh Node.js process with the session's working directory. It is JavaScript, or TypeScript with erasable types only (no enums or namespaces). Use `return` for the result; without one the result is null. console output is returned as logs.",
  'Use JavaScript and Node.js built-in modules for computation, for example `await import("node:crypto")`; static `import` statements are not allowed. `fetch` and other network use work directly but are not recorded. Files and processes go through tools, which are recorded: reading files, importing project files or packages, writing files and starting processes directly are refused. Use tools.pi.read, grep, find and ls to read, tools.pi.write and edit to change files, and tools.pi.bash for commands.',
  "Tool arguments and results, and the returned value, cross a JSON boundary: Dates become strings, Map/Set become `{}`, undefined fields are dropped, and BigInt or cyclic values are refused.",
  "When the program returns or throws, tool calls already started still finish and are reported; nothing is cancelled. Await every call you start: an unhandled rejection fails the program. Timers and servers do not outlive the program.",
];

/**
 * Budgeted catalog: every namespace is always listed with its tool count; full call signatures
 * are inlined against `catalogBudget` (estimated tokens, chars/4) round-robin across namespaces,
 * so every namespace gets some representation before any namespace gets everything. The section
 * states exactly how comprehensive it is.
 */
export const catalogInstructions = <R>(tools: HostTools<R>, catalogBudget: number): string => {
  if (!Number.isSafeInteger(catalogBudget) || catalogBudget < 0) {
    throw new RangeError("catalogBudget must be a non-negative safe integer");
  }
  const described = visibleDefinitions(tools).map(({ description }) => description);
  const namespaces = new Map<string, Array<ToolDescription>>();
  for (const tool of described) {
    const namespace = tool.path.split(".", 1)[0]!;
    const group = namespaces.get(namespace) ?? [];
    group.push(tool);
    namespaces.set(namespace, group);
  }
  const ordered = [...namespaces].sort(([left], [right]) => compareText(left, right));

  const selections = ordered.map(([namespace, group]) => ({
    namespace,
    picked: new Set<ToolDescription>(),
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
  const shown = new Map(selections.map(({ namespace, picked }) => [namespace, picked]));
  const totalShown = selections.reduce((total, { picked }) => total + picked.size, 0);
  const complete = totalShown === described.length;
  const empty = described.length === 0;

  const intro = empty
    ? ["`tools` is empty; no Code Mode tools are available."]
    : [
        complete
          ? "`tools` contains the Code Mode tools listed below. Surrounding agent tools are not available inside the program."
          : "`tools` contains the Code Mode tools listed or searchable below. Surrounding agent tools are not available inside the program.",
        "Do not infer or normalize tool names; use only exact signatures shown below or returned by search.",
      ];

  const workflow = empty
    ? []
    : [
        "",
        "## Workflow",
        "",
        ...(complete
          ? [
              "1. Pick a tool from the list under `## Available tools`; each line is the exact call signature.",
              "2. Call it as shown: `const result = await tools.<namespace>.<tool>(input)`.",
              "3. Return only the fields you need; avoid returning large raw payloads.",
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
        "- Filter, aggregate, and transform results in code when that preserves the evidence needed for the next decision. Batch already-known work; inspect results before choosing actions that require judgment.",
        "- A result typed `Promise<unknown>` may be structured data or text. Check its shape before reading fields.",
        "- Run independent calls in parallel: `await Promise.all(items.map((item) => tools.<namespace>.<tool>(item)))`.",
        "- `Object.keys(tools)` lists namespaces and `Object.keys(tools.<namespace>)` lists its tools.",
        ...(complete
          ? []
          : [
              '- Browse one namespace: `await tools.$codemode.search({ query: "", namespace: "<name>" })`.',
              "- If search returns `next`, repeat the same search with `offset: next.offset`.",
            ]),
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
      const label =
        picked.size === group.length
          ? count
          : picked.size === 0
            ? `${count}, none shown`
            : `${count}, ${picked.size} shown`;
      toolSection.push(`- ${namespace} (${label})`);
      for (const tool of group) if (picked.has(tool)) toolSection.push(catalogLine(tool));
    }
    if (!complete) {
      toolSection.push(
        "",
        "Search returns complete callable signatures:",
        `- ${searchDescription.signature}`,
      );
    }
  }

  return [...intro, ...workflow, ...rules, ...LANGUAGE, ...toolSection].join("\n");
};
