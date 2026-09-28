/**
 * Diagnostics for failed programs. The child reports what escaped and where; Pi owns every
 * message. A tool failure keeps the diagnostic Pi recorded for that request.
 */
import type { CodeModeDiagnostic, CodeModeLocation } from "./diagnostic.ts";
import type { ChildFailure } from "./protocol.ts";
import { type HostTools, isNamespacePath, nearestToolPaths } from "./tool-tree.ts";

const AWAIT_HINT =
  "Await tool calls and async work - `const result = await tools.ns.tool(...)` - so failures can be caught and handled.";

/** `tools.pi.nope is not a function`, as V8 words it. */
const NOT_A_FUNCTION = /^(tools(?:\.[A-Za-z_$][\w$]*)+) is not a function$/u;

const locationOf = (failure: ChildFailure): { readonly location?: CodeModeLocation } =>
  failure.line === undefined
    ? {}
    : { location: { line: failure.line, column: failure.column ?? 1 } };

/** A call to a tool path that does not exist, named as the program wrote it. */
const unknownTool = <R>(
  tools: HostTools<R>,
  expression: string,
  failure: ChildFailure,
): CodeModeDiagnostic => {
  const path = expression.split(".").slice(1);
  const tool = path.join(".");
  if (isNamespacePath(tools, path)) {
    return {
      kind: "UnknownTool",
      message: `Tool '${tool}' is not callable.`,
      ...locationOf(failure),
      facts: { tool, toolIssue: "not-callable" },
    };
  }
  const nearest = nearestToolPaths(tools, path);
  return {
    kind: "UnknownTool",
    message: `Unknown tool '${tool}'.`,
    ...locationOf(failure),
    suggestions: [
      ...(nearest.length > 0 ? [`Did you mean ${nearest.join(" or ")}?`] : []),
      "Use tools.$codemode.search({ query }) to find available tools.",
    ],
    facts: { tool, toolIssue: "unknown" },
  };
};

const escaped = (failure: ChildFailure, text: string): string =>
  failure.via === "unhandled"
    ? `Unhandled rejection: ${text}`
    : failure.via === "uncaught"
      ? `Uncaught exception: ${text}`
      : `Uncaught ${text}`;

/** What Node's permission model refused, named by the flag its message suggests. */
const REFUSED = [
  {
    flag: "--allow-fs-read",
    action: "read files",
    tools: "tools.pi.read, tools.pi.grep, tools.pi.find or tools.pi.ls",
    recorded: "read",
  },
  {
    flag: "--allow-fs-write",
    action: "write files",
    tools: "tools.pi.write or tools.pi.edit",
    recorded: "change",
  },
  {
    flag: "--allow-child-process",
    action: "start processes",
    tools: "tools.pi.bash",
    recorded: "command",
  },
];

const refusal = (failure: ChildFailure): string => {
  if (failure.module === true) {
    return "Programs can't import project files or packages. Use node: built-in modules, and read files with tools.pi.read.";
  }
  const refused = REFUSED.find(({ flag }) => (failure.message ?? "").includes(flag));
  return refused === undefined
    ? "Programs can't use this Node.js API directly. Use tools.pi.* for files and processes so the work is recorded."
    : `Programs can't ${refused.action} directly. Use ${refused.tools} so the ${refused.recorded} is recorded.`;
};

/** Node's refusal points at launch flags the program cannot use; name the recorded tool. */
const accessDenied = (failure: ChildFailure): CodeModeDiagnostic => ({
  kind: "ExecutionFailure",
  message: refusal(failure),
  ...locationOf(failure),
  ...(failure.message !== undefined && { facts: { reason: failure.message } }),
});

const CALLBACK_HINT =
  "It was thrown outside the program's await chain, such as in a timer or event callback.";

export const childFailureDiagnostic = <R>(
  failure: ChildFailure,
  tools: HostTools<R>,
  callFailures: ReadonlyMap<number, CodeModeDiagnostic>,
): CodeModeDiagnostic => {
  const location = locationOf(failure);
  const message = failure.message ?? "";
  switch (failure.kind) {
    case "syntax":
      return {
        kind: "ParseError",
        message: `SyntaxError: ${message}`,
        ...location,
        facts: { reason: message },
      };
    case "tool": {
      const recorded = failure.seq === undefined ? undefined : callFailures.get(failure.seq);
      if (recorded === undefined) {
        return { kind: "ExecutionFailure", message: "A tool call failed.", ...location };
      }
      return failure.via === "unhandled"
        ? {
            ...recorded,
            message: `Unhandled rejection from an un-awaited tool call: ${recorded.message}`,
            ...location,
            suggestions: [...(recorded.suggestions ?? []), AWAIT_HINT],
          }
        : { ...recorded, ...location };
    }
    case "arguments":
      return {
        kind: "InvalidDataValue",
        message,
        ...location,
        facts: {
          owner: `Arguments for ${failure.tool ?? "the tool"}`,
          ...(failure.tool !== undefined && { tool: failure.tool.replace(/^tools\./u, "") }),
        },
      };
    case "closed":
      return { kind: "ExecutionFailure", message, ...location };
    case "return":
      return {
        kind: "InvalidDataValue",
        message: `The return value must be JSON data: ${message}`,
        facts: { owner: "The return value" },
      };
    case "thrown": {
      if (failure.code === "ERR_ACCESS_DENIED") return accessDenied(failure);
      const unknown = failure.name === "TypeError" ? NOT_A_FUNCTION.exec(message) : null;
      if (unknown !== null && failure.via !== "uncaught") {
        return unknownTool(tools, unknown[1]!, failure);
      }
      const text = failure.name === undefined ? message : `${failure.name}: ${message}`;
      return {
        kind: "ExecutionFailure",
        message: escaped(failure, text),
        ...location,
        ...(failure.via === "unhandled" && { suggestions: [AWAIT_HINT] }),
        ...(failure.via === "uncaught" && { suggestions: [CALLBACK_HINT] }),
      };
    }
  }
};
