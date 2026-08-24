/**
 * The exact guest catalog: all seven Pi built-ins under `tools.pi` plus the runtime-owned
 * `tools.$codemode.search`. The Pi leaves dispatch directly against fresh built-in definitions;
 * they intentionally do not inherit Pi middleware, registered overrides, or approval/preview
 * extensions. MCP and arbitrary dynamic dispatch remain outside this package.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CodeMode, Tool, toolError } from "../boundary/codemode-runtime.ts";
import type { NestedPiToolDispatch, PiGuestToolName } from "../boundary/host-builtin-tools.ts";
import type { CumulativeOutputBudget } from "./limits.ts";

/** Input contracts validated by the runtime before any nested dispatch happens. */
const ReadInput = Schema.Struct({
  path: Schema.String,
  offset: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
});
const BashInput = Schema.Struct({
  command: Schema.String,
  timeout: Schema.optionalKey(Schema.Number),
});
const EditInput = Schema.Struct({
  path: Schema.String,
  edits: Schema.Array(
    Schema.Struct({
      oldText: Schema.String,
      newText: Schema.String,
    }),
  ).check(Schema.isMinLength(1)),
});
const WriteInput = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
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

const GUEST_TOOL_DESCRIPTIONS = {
  read:
    "Read one text file (same behavior and filesystem authority as the top-level read tool; " +
    "absolute paths are allowed). Returns the file text; image files are refused.",
  bash:
    "Execute a command through Pi's default local Bash implementation with full local-user " +
    "process, filesystem, environment, and network authority. This does not inherit registered " +
    "Bash overrides or session-specific shell options. Output is limited to a 2,000-line/50 KiB " +
    "tail; larger full output is saved to a temporary file named in the result. Optional timeout " +
    "is in seconds; nonzero exit, timeout, and abort are catchable tool failures.",
  edit:
    "Edit one unrestricted relative, absolute, or home-relative file with a non-empty canonical " +
    "edits array. Every oldText must uniquely match the original file and edits must not overlap. " +
    "Mutations run immediately without nested approval or preview middleware.",
  write:
    "Create or overwrite one unrestricted relative, absolute, or home-relative file, creating " +
    "parent directories. The write runs immediately without nested approval or preview middleware.",
  grep:
    "Search file contents for a regex pattern (ripgrep-backed, respects .gitignore). " +
    "Optional path, glob filter, ignoreCase, literal, context lines, and match limit.",
  find: "Find files by glob pattern (respects .gitignore). Optional search path and result limit.",
  ls: "List directory contents. Optional path (defaults to the session cwd) and entry limit.",
} satisfies Readonly<Record<PiGuestToolName, string>>;

const GUEST_TOOL_INPUTS = {
  read: ReadInput,
  bash: BashInput,
  edit: EditInput,
  write: WriteInput,
  grep: GrepInput,
  find: FindInput,
  ls: LsInput,
} as const;

const guestTool = <Name extends PiGuestToolName>(name: Name, invoke: NestedPiToolDispatch) =>
  Tool.make({
    description: GUEST_TOOL_DESCRIPTIONS[name],
    input: GUEST_TOOL_INPUTS[name],
    output: Schema.String,
    run: (input) => invoke(name, input),
  });

/** The `pi` namespace exposed to programs; every leaf validates input with Effect Schema. */
export const makeCodeModeGuestTools = (invoke: NestedPiToolDispatch) => ({
  pi: {
    read: guestTool("read", invoke),
    bash: guestTool("bash", invoke),
    edit: guestTool("edit", invoke),
    write: guestTool("write", invoke),
    grep: guestTool("grep", invoke),
    find: guestTool("find", invoke),
    ls: guestTool("ls", invoke),
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
      Effect.catchTag("ToolError", (error) =>
        Effect.fail(toolError(budget.admitFailure(error.message))),
      ),
      Effect.flatMap((guestData) => {
        const admission = budget.admit(guestData);
        return admission.admitted
          ? Effect.succeed(guestData)
          : Effect.fail(toolError(budget.admitFailure(admission.message)));
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
