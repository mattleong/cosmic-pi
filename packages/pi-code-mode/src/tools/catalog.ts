/**
 * The reviewed guest catalog: Pi built-ins under `tools.pi`, the explicit session-scoped
 * Background Tasks adapter under `tools.session`, and runtime-owned discovery. Pi definitions
 * dispatch directly; the background adapter uses its own versioned current-session protocol.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { BackgroundTaskToolInput } from "pi-background-task/code-mode";
import { CodeMode, Tool, toolError, type ToolError } from "../boundary/codemode-runtime.ts";
import {
  BackgroundTaskCodeModeOutputSchema,
  type BackgroundTaskDispatch,
} from "../boundary/host-background-task.ts";
import type { NestedPiToolDispatch, PiGuestToolName } from "../boundary/host-builtin-tools.ts";
import type { CumulativeOutputBudget } from "./limits.ts";

/** Input contracts validated by the runtime before any nested dispatch happens. */
const ReadInput = Schema.Struct({
  path: Schema.String,
  offset: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
});
const ShellInput = Schema.Struct({
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
const PositiveFinite = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0.001));
const NonNegativeInteger = Schema.Natural;
const BackgroundTaskInput = Schema.Struct({
  action: Schema.Literals(["start", "list", "status", "logs", "wait", "stop", "stop_all", "clear"]),
  command: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  timeoutSeconds: Schema.optionalKey(PositiveFinite),
  id: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.Literals(["active", "completed", "all"])),
  until: Schema.optionalKey(Schema.Literals(["exit", "output"])),
  contains: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  afterCursor: Schema.optionalKey(NonNegativeInteger),
  tailLines: Schema.optionalKey(
    Schema.Natural.check(Schema.isBetween({ minimum: 1, maximum: 2_000 })),
  ),
  waitSeconds: Schema.optionalKey(
    Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: 0, maximum: 120 })),
  ),
  force: Schema.optionalKey(Schema.Boolean),
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
  powershell:
    "Execute a command through Pi's native Windows PowerShell implementation with full local-user " +
    "process, filesystem, environment, and network authority. Available only on Windows and does " +
    "not inherit registered overrides or session-specific shell options.",
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
  bash: ShellInput,
  powershell: ShellInput,
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

const backgroundTaskTool = (invoke: BackgroundTaskDispatch) =>
  Tool.make({
    description:
      "Start and manage session-scoped local background commands through the explicit " +
      "pi-background-task adapter. Tasks may outlive this Code Mode call but are terminated " +
      "when the Pi session closes. Use wait once at a dependency barrier instead of polling.",
    input: BackgroundTaskInput,
    output: BackgroundTaskCodeModeOutputSchema,
    run: (input) => invoke(input satisfies BackgroundTaskToolInput),
  });

export interface CodeModeCatalogOptions {
  /** True only when the current platform supplied a native PowerShell definition. */
  readonly includePowerShell: boolean;
}

/** The tool tree exposed to programs; every leaf validates input with Effect Schema. */
export const makeCodeModeGuestTools = (
  invokePi: NestedPiToolDispatch,
  invokeBackgroundTask: BackgroundTaskDispatch,
  options: CodeModeCatalogOptions,
) => {
  const portablePi = {
    read: guestTool("read", invokePi),
    bash: guestTool("bash", invokePi),
    edit: guestTool("edit", invokePi),
    write: guestTool("write", invokePi),
    grep: guestTool("grep", invokePi),
    find: guestTool("find", invokePi),
    ls: guestTool("ls", invokePi),
  };
  return {
    pi: options.includePowerShell
      ? { ...portablePi, powershell: guestTool("powershell", invokePi) }
      : portablePi,
    session: {
      backgroundTask: backgroundTaskTool(invokeBackgroundTask),
    },
  };
};

/**
 * Composes one execution's guest tools with cumulative-output admission. Structured background
 * results are charged as compact JSON; existing built-in strings retain raw UTF-8 accounting.
 */
export const makeExecutionGuestTools = (
  dispatchPi: NestedPiToolDispatch,
  dispatchBackgroundTask: BackgroundTaskDispatch,
  budget: CumulativeOutputBudget,
  options: CodeModeCatalogOptions,
) => {
  const admitOutput = <Value>(
    effect: Effect.Effect<Value, ToolError>,
    serialize: (value: Value) => string,
  ): Effect.Effect<Value, ToolError> =>
    effect.pipe(
      Effect.catchTag("ToolError", (error) =>
        Effect.fail(toolError(budget.admitFailure(error.message))),
      ),
      Effect.flatMap((value) => {
        const admission = budget.admit(serialize(value));
        return admission.admitted
          ? Effect.succeed(value)
          : Effect.fail(toolError(budget.admitFailure(admission.message)));
      }),
    );

  return makeCodeModeGuestTools(
    (name, input) => admitOutput(dispatchPi(name, input), (value) => value),
    (input) => admitOutput(dispatchBackgroundTask(input), (value) => JSON.stringify(value) ?? ""),
    options,
  );
};

/** Model-facing catalog instructions rendered over the same shapes the program will see. */
export const describeCodeModeCatalog = (
  catalogBudget: number,
  options: CodeModeCatalogOptions,
): string =>
  CodeMode.make({
    tools: makeCodeModeGuestTools(
      () => Effect.fail(toolError("Tool preview is not executable.")),
      () => Effect.fail(toolError("Tool preview is not executable.")),
      options,
    ),
    discovery: { catalogBudget },
  }).instructions();
