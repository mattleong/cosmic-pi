/** Human messages for runtime diagnostics. The raw diagnostic stays in the result. */
import { firstLineMessage } from "pi-code-previews";

/** The runtime's diagnostic envelope: `[Kind] (line L, column C) message`. */
const ENVELOPE = /^\[([A-Za-z]+)\](?: \(line (\d+), column \d+\))? ([^\n]*)/u;
/** Results written before the host dropped it repeat the location after the message. */
const REPEATED_LOCATION = / \(line \d+, col \d+\)(?=\.?$)/u;

export interface ProgramDiagnostic {
  readonly kind: string;
  readonly line?: string;
  readonly message: string;
}

export const parseProgramDiagnostic = (text: string): ProgramDiagnostic | undefined => {
  const envelope = ENVELOPE.exec(text);
  if (!envelope) return undefined;
  const [, kind = "", line, message = ""] = envelope;
  return { kind, ...(line && { line }), message: message.replace(REPEATED_LOCATION, "") };
};

/** Nested tool names as call rows show them. */
export const nestedToolName = (name: string): string =>
  name.startsWith("pi.")
    ? name.slice(3)
    : name === "mcp.request"
      ? "mcp"
      : name === "session.backgroundTask"
        ? "background_task"
        : name;

/** The failure itself, without the guidance that follows it for the agent. */
const lead = (text: string) =>
  firstLineMessage(text, "")
    .split(/; | - /u)[0]!
    .trim();

const duration = (ms: number) =>
  ms < 1_000
    ? `${ms} ms`
    : ms < 60_000
      ? `${Number((ms / 1_000).toFixed(1))} s`
      : `${Number((ms / 60_000).toFixed(1))} min`;

/** Schema issue paths such as `["edits"][0]["oldText"]`, shown as `edits[0].oldText`. */
const schemaPath = (path: string): string | undefined => {
  const segments = [...path.matchAll(/\[(?:"((?:[^"\\]|\\.)*)"|(\d+))\]/gu)];
  if (!segments.length || segments.map(([whole]) => whole).join("") !== path) return undefined;
  return segments
    .map(([, key, index], position) =>
      index !== undefined ? `[${index}]` : `${position > 0 ? "." : ""}${key}`,
    )
    .join("");
};

const inputProblem = (reason: string): string => {
  const issue = firstLineMessage(reason, "the value does not match its schema");
  const located = /^(.*?) at (\[.*\])$/u.exec(issue);
  const path = located?.[2] === undefined ? undefined : schemaPath(located[2]);
  if (!located?.[1] || path === undefined) return issue;
  if (located[1] === "Expected no excess property") return `unexpected field "${path}"`;
  if (located[1] === "Missing key") return `missing field "${path}"`;
  return `${located[1]} at ${path}`;
};

const describe = (kind: string, message: string): string => {
  switch (kind) {
    case "ParseError":
      return `Syntax error: ${lead(message.replace(/^Failed to parse TypeScript:\s*/u, "")) || "the program could not be parsed"}`;
    case "UnsupportedSyntax": {
      const syntax = /^Syntax '([A-Za-z]+)' is not supported/u.exec(message)?.[1];
      return syntax
        ? `Unsupported syntax: ${syntax.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase()}`
        : lead(message);
    }
    case "UnknownTool": {
      const namespace = /^Unknown tool namespace '([^']+)'/u.exec(message)?.[1];
      const tool = /^Unknown tool '([^']+)'/u.exec(message)?.[1];
      const uncallable = /^Tool '([^']+)' is not callable/u.exec(message)?.[1];
      return namespace
        ? `No tool namespace named ${namespace}`
        : tool
          ? `No tool named ${tool}`
          : uncallable
            ? `${uncallable} is not a callable tool`
            : lead(message);
    }
    case "InvalidToolInput": {
      const arity = /^Tool '([^']+)' expects exactly one input object/u.exec(message)?.[1];
      if (arity) return `${nestedToolName(arity)} expects one input object`;
      const input = /^Invalid input for tool '([^']+)': (.*)$/u.exec(message);
      return input?.[1]
        ? `Invalid ${nestedToolName(input[1])} input: ${inputProblem(input[2] ?? "")}`
        : lead(message);
    }
    case "InvalidToolOutput": {
      const tool = /^Invalid output from tool '([^']+)'/u.exec(message)?.[1];
      return tool ? `${nestedToolName(tool)} returned invalid output` : lead(message);
    }
    case "InvalidDataValue": {
      const owner = /^(.+) must contain plain objects only/u.exec(message)?.[1];
      return owner
        ? `${owner === "Execution result" ? "The result" : owner} must be plain data`
        : lead(message);
    }
    case "ToolCallLimitExceeded": {
      const limit = /tool-call limit of (\d+)/u.exec(message)?.[1];
      return limit ? `Stopped at the ${limit}-call limit` : lead(message);
    }
    case "TimeoutExceeded": {
      const ms = /timed out after (\d+)ms/u.exec(message)?.[1];
      return ms ? `Timed out after ${duration(Number(ms))}` : lead(message);
    }
    case "ToolFailure": {
      const nested = /^Nested tool '([^']+)' (.*)$/u.exec(message);
      return nested?.[1] ? `${nestedToolName(nested[1])} ${lead(nested[2] ?? "")}` : lead(message);
    }
    default:
      return lead(message);
  }
};

const refusalReason = (kind: string, message: string): string => {
  if (kind === "InvalidToolInput")
    return /^Tool '[^']+' expects exactly one input object/u.test(message)
      ? "expects one input object"
      : inputProblem(/^Invalid input for tool '[^']+': (.*)$/u.exec(message)?.[1] ?? message);
  if (kind === "UnknownTool")
    return /^Tool '[^']+' is not callable/u.test(message) ? "not a callable tool" : "no such tool";
  if (kind === "ToolCallLimitExceeded") {
    const limit = /tool-call limit of (\d+)/u.exec(message)?.[1];
    return limit ? `over the ${limit}-call limit` : "over the call limit";
  }
  return describe(kind, message);
};

/** The reason on the row of a call refused before its tool ran. */
export const describeRefusal = (failure: { readonly kind: string; readonly message: string }) => {
  const reason = refusalReason(failure.kind, failure.message);
  return firstLineMessage(
    `Not sent: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`,
    "Not sent",
  );
};

/** One human line naming what stopped the program and, when known, where. */
export const describeProgramFailure = (diagnostic: ProgramDiagnostic): string =>
  firstLineMessage(
    `${describe(diagnostic.kind, diagnostic.message) || "The program failed"}${diagnostic.line ? ` (line ${diagnostic.line})` : ""}`,
    "The program failed",
  );
