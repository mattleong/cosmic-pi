import { projectMcpCompactSummary } from "pi-mcp/code-mode";
import {
  BackgroundTaskCodeModeInputSchema,
  projectBackgroundTaskCompactSummary,
} from "pi-background-task/code-mode";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core";
import { describeBuiltinCompactSubject, type BuiltinCompactTool } from "pi-code-previews";
import { decodeOption, truncateDisplay } from "./format.ts";

export const MAX_NESTED_SUBJECT_LENGTH = 1024;
const tools = new Map<string, BuiltinCompactTool>([
  ["pi.read", "read"],
  ["pi.bash", "bash"],
  ["pi.powershell", "bash"],
  ["pi.edit", "edit"],
  ["pi.write", "write"],
  ["pi.grep", "grep"],
  ["pi.find", "find"],
  ["pi.ls", "ls"],
]);
const InputSchema = Schema.Struct({
  path: Schema.optional(Schema.Unknown),
  command: Schema.optional(Schema.Unknown),
  pattern: Schema.optional(Schema.Unknown),
  offset: Schema.optional(Schema.Unknown),
  limit: Schema.optional(Schema.Unknown),
});

// Redact the complete allowlisted field before the shared formatter clips or escapes it.
const safeField = <Value>(value: Value): string | undefined =>
  Predicate.isString(value)
    ? sanitizeDiagnosticContent(sanitizeTerminalLine(value), {
        maximumLength: Number.MAX_SAFE_INTEGER,
      })
    : undefined;

export const normalizeNestedSubject = (subject: string): string =>
  truncateDisplay(safeField(subject) ?? "", MAX_NESTED_SUBJECT_LENGTH);

/** Best-effort presentation only; never retain input objects, write/edit bodies or MCP arguments. */
export function describeNestedSubject<Input>(
  name: string,
  input: Input,
  cwd: string,
): string | undefined {
  try {
    if (name === "mcp.request" || name === "session.backgroundTask") {
      const heading =
        name === "mcp.request"
          ? projectMcpCompactSummary({
              phase: "running",
              args: input,
              result: undefined,
              isError: false,
            })
          : projectBackgroundTaskCompactSummary({
              phase: "running",
              args: decodeOption(BackgroundTaskCodeModeInputSchema, input) ?? {},
              result: undefined,
              isError: false,
            });
      return heading === undefined
        ? undefined
        : normalizeNestedSubject(heading.subject) || undefined;
    }
    const tool = tools.get(name);
    if (tool === undefined) return undefined;
    const decoded = decodeOption(InputSchema, input);
    if (decoded === undefined) return undefined;
    const subject = describeBuiltinCompactSubject(
      tool,
      {
        path: safeField(decoded.path),
        command: safeField(decoded.command),
        pattern: safeField(decoded.pattern),
        offset: decoded.offset,
        limit: decoded.limit,
      },
      cwd,
    );
    return normalizeNestedSubject(subject) || undefined;
  } catch {
    // A display formatter, path adapter or hostile optional input cannot break dispatch.
    return undefined;
  }
}
