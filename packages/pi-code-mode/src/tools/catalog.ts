/**
 * The exact guest tool catalog: `tools.pi.read`, `tools.pi.grep`, `tools.pi.find`, and
 * `tools.pi.ls`, plus the runtime-owned `tools.$codemode.search`. Nothing else is ever
 * exposed — no bash, edit, write, MCP, network, process, or dynamic dispatch of any kind
 * (see ADR 0003: nested dispatch bypasses Pi middleware, so Code Mode stays read-only).
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CodeMode, Tool, toolError, type ToolError } from "../boundary/codemode-runtime.ts";
import type { NestedPiToolDispatch, PiGuestToolName } from "../boundary/host-builtin-tools.ts";
import type { CumulativeOutputBudget } from "./limits.ts";

/** Input contracts validated by the runtime before any nested dispatch happens. */
const ReadInput = Schema.Struct({
  path: Schema.String,
  offset: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
});
const GrepInput = Schema.Struct({
  pattern: Schema.String,
  path: Schema.optionalKey(Schema.String),
  glob: Schema.optionalKey(Schema.String),
  ignoreCase: Schema.optionalKey(Schema.Boolean),
  literal: Schema.optionalKey(Schema.Boolean),
  context: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
});
const FindInput = Schema.Struct({
  pattern: Schema.String,
  path: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Number),
});
const LsInput = Schema.Struct({
  path: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Number),
});

const GUEST_TOOL_DESCRIPTIONS: Readonly<Record<PiGuestToolName, string>> = {
  read:
    "Read one text file (same behavior and filesystem authority as the top-level read tool; " +
    "absolute paths are allowed). Returns the file text; image files are refused.",
  grep:
    "Search file contents for a regex pattern (ripgrep-backed, respects .gitignore). " +
    "Optional path, glob filter, ignoreCase, literal, context lines, and match limit.",
  find: "Find files by glob pattern (respects .gitignore). Optional search path and result limit.",
  ls: "List directory contents. Optional path (defaults to the session cwd) and entry limit.",
};

export type GuestInvoke = (
  name: PiGuestToolName,
  input: unknown,
) => Effect.Effect<string, ToolError>;

/** The `pi` namespace exposed to programs; every leaf validates input with Effect Schema. */
export const makeCodeModeGuestTools = (invoke: GuestInvoke) => ({
  pi: {
    read: Tool.make({
      description: GUEST_TOOL_DESCRIPTIONS.read,
      input: ReadInput,
      output: Schema.String,
      run: (input) => invoke("read", input),
    }),
    grep: Tool.make({
      description: GUEST_TOOL_DESCRIPTIONS.grep,
      input: GrepInput,
      output: Schema.String,
      run: (input) => invoke("grep", input),
    }),
    find: Tool.make({
      description: GUEST_TOOL_DESCRIPTIONS.find,
      input: FindInput,
      output: Schema.String,
      run: (input) => invoke("find", input),
    }),
    ls: Tool.make({
      description: GUEST_TOOL_DESCRIPTIONS.ls,
      input: LsInput,
      output: Schema.String,
      run: (input) => invoke("ls", input),
    }),
  },
});

/**
 * Composes one execution's guest tools: nested dispatch followed by cumulative-output
 * admission. The admitted value is the exact string entering the guest, counted exactly once.
 */
export const makeExecutionGuestTools = (
  dispatch: NestedPiToolDispatch,
  budget: CumulativeOutputBudget,
) =>
  makeCodeModeGuestTools((name, input) =>
    dispatch(name, input).pipe(
      Effect.flatMap((guestData) => {
        const admission = budget.admit(guestData);
        return admission.admitted
          ? Effect.succeed(guestData)
          : Effect.fail(toolError(admission.message));
      }),
    ),
  );

/**
 * Model-facing catalog instructions for the tool description, produced by the runtime's
 * budgeted discovery renderer over the same tool shapes the program will see. The preview
 * leaves are deliberately not executable.
 */
export const describeCodeModeCatalog = (catalogBudget: number): string =>
  CodeMode.make({
    tools: makeCodeModeGuestTools(() => Effect.fail(toolError("Tool preview is not executable."))),
    discovery: { catalogBudget },
  }).instructions();
