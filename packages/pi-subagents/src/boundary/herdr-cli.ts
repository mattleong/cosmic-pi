// Herdr CLI process ownership and inherited-session selection are isolated at this boundary.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { runBoundedProcessNode } from "pi-cosmic-core";
import { exactPaneContext } from "../backend/herdr-ownership.ts";
import type { HerdrPaneProcessInfo } from "../backend/herdr-shell-readiness.ts";
import {
  invalidRequest as readinessError,
  processError,
  type InvalidSubagentRequestError,
  type SubagentProcessError,
} from "../run/errors.ts";
import type { SubagentRuntime } from "../domain/routing.ts";
import { hasControlCharacter, pickEnvironment } from "./harness-shared.ts";
import { HERDR_CLI_ENVIRONMENT_KEYS } from "./herdr-environment.ts";

const HERDR_EXECUTABLE = "herdr";
// Reviewed Herdr 0.8 and 0.9 protocols. Unknown versions still fail before mutation.
const SUPPORTED_PROTOCOLS = [20, 22] as const;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const COMMAND_TIMEOUT_MILLIS = 15_000;
const START_TIMEOUT_MILLIS = 70_000;
const CONFIRMED_AGENT_START_REJECTION_CODES = new Set([
  "invalid_agent_name",
  "unsupported_agent_kind",
  "invalid_agent_argument",
  "invalid_agent_timeout",
  "agent_pane_not_found",
  // Herdr rejects this before launch when the pane's interactive shell does not own the
  // foreground. The host probes that precondition before issuing the one allowed start.
  "agent_pane_busy",
  // `agent_pane_unavailable` is intentionally absent: Herdr 0.8 can emit it
  // after runtime input dispatch when post-send agent evidence disappears.
  "agent_start_input_failed",
  "agent_name_taken",
]);
const CONFIRMED_AGENT_PROMPT_REJECTION_CODES = new Set([
  // Protocol 20 rejects before sending text or Enter when the agent is already at a question
  // or approval dialog. Protocol 19 never emits this code.
  "agent_blocked",
]);
const MUTATING_OPERATIONS = new Set([
  "split pane",
  "rename pane",
  "activate pane input",
  "confirm pane shell",
  "prepare pane environment",
  "load pane secrets",
  "start agent",
  "prompt agent",
  "close pane",
]);

const BoundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const BoundedLabel = Schema.String.check(Schema.isMaxLength(512));
const BoundedPath = Schema.String.check(Schema.isMaxLength(4_096));
const AgentStatus = Schema.Literals(["idle", "working", "blocked", "done", "unknown"] as const);
const SessionInfo = Schema.Struct({
  source: Schema.String.check(Schema.isMaxLength(128)),
  agent: Schema.String.check(Schema.isMaxLength(64)),
  kind: Schema.Literals(["id", "path"] as const),
  value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
});
const WorkspaceSchema = Schema.Struct({
  workspace_id: BoundedId,
  label: BoundedLabel,
  focused: Schema.Boolean,
  active_tab_id: BoundedId,
});
const TabSchema = Schema.Struct({
  tab_id: BoundedId,
  workspace_id: BoundedId,
  label: BoundedLabel,
  pane_count: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  focused: Schema.Boolean,
});
const PaneSchema = Schema.Struct({
  pane_id: BoundedId,
  terminal_id: BoundedId,
  workspace_id: BoundedId,
  tab_id: BoundedId,
  cwd: Schema.optional(Schema.NullOr(BoundedPath)),
  foreground_cwd: Schema.optional(Schema.NullOr(BoundedPath)),
  label: Schema.optional(Schema.NullOr(BoundedLabel)),
  focused: Schema.Boolean,
  agent_status: AgentStatus,
});
const AgentSchema = Schema.Struct({
  ...PaneSchema.fields,
  name: Schema.optional(Schema.NullOr(BoundedLabel)),
  agent: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(64)))),
  state_change_seq: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  interactive_ready: Schema.optional(Schema.Boolean),
  agent_session: Schema.optional(Schema.NullOr(SessionInfo)),
});
const SnapshotSchema = Schema.Struct({
  version: Schema.String.check(Schema.isMaxLength(64)),
  protocol: Schema.Number.check(Schema.isInt()),
  focused_workspace_id: Schema.optional(Schema.NullOr(BoundedId)),
  focused_tab_id: Schema.optional(Schema.NullOr(BoundedId)),
  focused_pane_id: Schema.optional(Schema.NullOr(BoundedId)),
  workspaces: Schema.Array(WorkspaceSchema).check(Schema.isMaxLength(512)),
  tabs: Schema.Array(TabSchema).check(Schema.isMaxLength(2_048)),
  panes: Schema.Array(PaneSchema).check(Schema.isMaxLength(4_096)),
  agents: Schema.Array(AgentSchema).check(Schema.isMaxLength(4_096)),
});
const EnvelopeSchema = Schema.Struct({ result: Schema.Unknown });
const ErrorEnvelopeSchema = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});
const SchemaDocument = Schema.Struct({
  protocol: Schema.Number.check(Schema.isInt()),
  schema_version: Schema.Number.check(Schema.isInt()),
});
const ClaudeAuthStatusSchema = Schema.Struct({ loggedIn: Schema.Literal(true) });
const PaneProcessInfoSchema = Schema.Struct({
  pane_id: BoundedId,
  shell_pid: Schema.optional(
    Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  ),
  foreground_process_group_id: Schema.optional(
    Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  ),
  foreground_processes: Schema.optional(
    Schema.Array(
      Schema.Struct({
        pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
        name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      }),
    ).check(Schema.isMaxLength(64)),
  ),
});
const SnapshotEnvelopeSchema = Schema.Struct({ snapshot: SnapshotSchema });
const AgentEnvelopeSchema = Schema.Struct({ agent: AgentSchema });
const PaneEnvelopeSchema = Schema.Struct({ pane: PaneSchema });
const PaneProcessInfoEnvelopeSchema = Schema.Struct({ process_info: PaneProcessInfoSchema });

const decodeErrorEnvelopeJsonOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(ErrorEnvelopeSchema),
);
const decodeUnknownJsonEffect = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeErrorEnvelopeOption = Schema.decodeUnknownOption(ErrorEnvelopeSchema);
const decodeEnvelopeEffect = Schema.decodeUnknownEffect(EnvelopeSchema);
const decodeSchemaDocumentEffect = Schema.decodeUnknownEffect(SchemaDocument);
const decodeClaudeAuthStatusEffect = Schema.decodeUnknownEffect(ClaudeAuthStatusSchema);

/** Projection of the ownership-relevant pane fields; labels and focus are never evidence. */
export interface HerdrPane {
  readonly paneId: string;
  readonly terminalId: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly cwd?: string | undefined;
  readonly foregroundCwd?: string | undefined;
  readonly agentStatus: "idle" | "working" | "blocked" | "done" | "unknown";
}

export type HerdrAgentSession = typeof SessionInfo.Type;

export interface HerdrAgent extends HerdrPane {
  readonly name?: string | undefined;
  readonly runtime?: string | undefined;
  readonly stateChangeSequence: number;
  readonly interactiveReady?: boolean | undefined;
  readonly agentSession?: HerdrAgentSession | undefined;
}

export interface HerdrSnapshot {
  readonly protocol: number;
  readonly workspaces: ReadonlyArray<{ readonly workspaceId: string }>;
  readonly tabs: ReadonlyArray<{ readonly tabId: string; readonly workspaceId: string }>;
  readonly panes: ReadonlyArray<HerdrPane>;
  readonly agents: ReadonlyArray<HerdrAgent>;
}

export interface HerdrCliContract {
  /** The immutable calling-pane selector inherited by this Pi process, when available. */
  readonly callingPaneId: string | undefined;
  readonly preflight: (
    runtime: SubagentRuntime,
  ) => Effect.Effect<void, InvalidSubagentRequestError>;
  readonly snapshot: Effect.Effect<HerdrSnapshot, SubagentProcessError>;
  readonly currentPane: Effect.Effect<HerdrPane, SubagentProcessError>;
  readonly splitPane: (
    paneId: string,
    cwd: string,
  ) => Effect.Effect<HerdrPane, SubagentProcessError>;
  readonly renamePane: (paneId: string, label: string) => Effect.Effect<void, SubagentProcessError>;
  readonly runPaneCommand: (
    paneId: string,
    command: string,
    operation:
      | "activate pane input"
      | "confirm pane shell"
      | "prepare pane environment"
      | "load pane secrets",
  ) => Effect.Effect<void, SubagentProcessError>;
  readonly paneProcessInfo: (
    paneId: string,
  ) => Effect.Effect<HerdrPaneProcessInfo, SubagentProcessError>;
  readonly startAgent: (input: {
    readonly runtime: SubagentRuntime;
    readonly paneId: string;
    readonly agentName: string;
    readonly argv: ReadonlyArray<string>;
  }) => Effect.Effect<HerdrAgent, SubagentProcessError>;
  readonly prompt: (
    agentName: string,
    text: string,
  ) => Effect.Effect<HerdrAgent, SubagentProcessError>;
  readonly closePane: (paneId: string) => Effect.Effect<void, SubagentProcessError>;
}

export interface HerdrCliLayerOptions {
  /** Test seam only. Production always uses the fixed `herdr` executable. */
  readonly executable?: string | undefined;
  /** Test seam only. Production inherits only the bounded Herdr session environment. */
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly commandTimeoutMillis?: number | undefined;
  /** Test seam only. Production uses the canonical runtime executable names. */
  readonly runtimeExecutables?: Partial<Record<SubagentRuntime, string>> | undefined;
}

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly overflowed: boolean;
  readonly timedOut: boolean;
  readonly cleanupUnconfirmed: boolean;
  readonly dispatched: boolean;
}

const validateNativePreflight = (runtime: SubagentRuntime, result: CommandResult) =>
  Effect.gen(function* () {
    if (result.cleanupUnconfirmed)
      return yield* readinessError(
        `${runtime}_preflight_cleanup_unconfirmed`,
        `${runtime} readiness probe cleanup could not be confirmed; candidate fallback is unsafe.`,
      );
    if (result.timedOut || result.overflowed)
      return yield* readinessError(
        `${runtime}_preflight_unbounded`,
        `${runtime} readiness probe exceeded its time or output bound.`,
      );
    if (result.code !== 0)
      return yield* readinessError(
        result.code === null ? `${runtime}_executable_unavailable` : `${runtime}_unauthenticated`,
        result.code === null
          ? `${runtime} executable is unavailable.`
          : `${runtime} authentication/readiness is unavailable.`,
      );
    if (runtime === "claude")
      yield* parseJson("inspect Claude authentication", result.stdout).pipe(
        Effect.flatMap(decodeClaudeAuthStatusEffect),
        Effect.mapError(() =>
          readinessError(
            "claude_unauthenticated",
            "Claude auth status did not return bounded authenticated evidence.",
          ),
        ),
      );
  });

const operationCode = (operation: string, suffix: string): string =>
  `herdr_${operation.replaceAll(/[^a-z0-9]+/giu, "_").replaceAll(/^_|_$/gu, "")}_${suffix}`;
const outcomeUncertain = (operation: string, detail: string) =>
  processError(
    operation,
    operationCode(operation, "outcome_uncertain"),
    `Herdr ${operation} was dispatched and may have applied, but its outcome is unconfirmed (${detail}). It will not be retried automatically.`,
  );
const cleanupUnconfirmed = (operation: string) =>
  processError(
    operation,
    operationCode(operation, "cleanup_unconfirmed"),
    `Herdr CLI cleanup could not be confirmed during ${operation}.`,
  );
const protocolError = (operation: string, code: string, message: string) =>
  MUTATING_OPERATIONS.has(operation)
    ? outcomeUncertain(operation, message)
    : processError(operation, code, message);

const runEffect = (
  executable: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  timeoutMillis: number,
  maximumBytes: number,
): Effect.Effect<CommandResult> =>
  runBoundedProcessNode({
    executable,
    args,
    environment,
    stdoutLimitBytes: maximumBytes,
    stderrLimitBytes: MAX_DIAGNOSTIC_BYTES,
    totalOutputLimitBytes: maximumBytes,
    timeoutMillis,
    cleanupTimeoutMillis: 1_000,
    detached: false,
    windowsHide: true,
  }).pipe(
    Effect.map((result) => ({ ...result, dispatched: true })),
    Effect.catch((error) =>
      Effect.succeed({
        code: null,
        stdout: "",
        stderr: "",
        overflowed: false,
        timedOut: false,
        cleanupUnconfirmed: false,
        dispatched: error.operation === "stream",
      }),
    ),
  );

const runCommand = (
  options: HerdrCliLayerOptions,
  args: ReadonlyArray<string>,
  operation: string,
  timeoutMillis = options.commandTimeoutMillis ?? COMMAND_TIMEOUT_MILLIS,
  maximumBytes = MAX_JSON_BYTES,
  confirmedRejectionCodes?: ReadonlySet<string>,
): Effect.Effect<string, SubagentProcessError> => {
  const command = runEffect(
    options.executable ?? HERDR_EXECUTABLE,
    args,
    options.environment ?? {},
    timeoutMillis,
    maximumBytes,
  ).pipe(
    Effect.mapError(() =>
      processError(operation, "herdr_cli_failed", `Herdr failed during ${operation}.`),
    ),
    Effect.flatMap((result) => {
      if (result.cleanupUnconfirmed) return Effect.fail(cleanupUnconfirmed(operation));
      if (result.timedOut)
        return Effect.fail(
          MUTATING_OPERATIONS.has(operation) && result.dispatched
            ? outcomeUncertain(operation, "the bounded command timed out")
            : processError(operation, "herdr_cli_timeout", `Herdr timed out during ${operation}.`),
        );
      if (result.overflowed)
        return Effect.fail(
          MUTATING_OPERATIONS.has(operation) && result.dispatched
            ? outcomeUncertain(operation, "the successful response exceeded its output bound")
            : processError(
                operation,
                "herdr_output_too_large",
                `Herdr output exceeded its bound during ${operation}.`,
              ),
        );
      if (result.code !== 0) {
        let code = result.code === null ? "herdr_executable_unavailable" : "herdr_cli_failed";
        let message = `Herdr command failed during ${operation}.`;
        let confirmedRejection = false;
        const decoded = decodeErrorEnvelopeJsonOption(result.stderr);
        if (Option.isSome(decoded)) {
          code = decoded.value.error.code.slice(0, 128);
          message = decoded.value.error.message.slice(0, 1_024);
          confirmedRejection = confirmedRejectionCodes?.has(code) === true;
        }
        return Effect.fail(
          MUTATING_OPERATIONS.has(operation) && result.dispatched && !confirmedRejection
            ? outcomeUncertain(
                operation,
                "the dispatched command failed without proof of non-application",
              )
            : processError(operation, code, message),
        );
      }
      return Effect.succeed(result.stdout);
    }),
  );
  // A mutation is a bounded, session-owned commit once the CLI child is dispatched. Effect
  // interruption therefore waits for its bounded result instead of detaching a live mutation.
  return MUTATING_OPERATIONS.has(operation) ? Effect.uninterruptible(command) : command;
};

const parseJson = (operation: string, source: string) =>
  decodeUnknownJsonEffect(source).pipe(
    Effect.mapError(() =>
      protocolError(
        operation,
        "herdr_json_invalid",
        `Herdr returned invalid JSON for ${operation}.`,
      ),
    ),
  );

const decodeEnvelope = (operation: string, source: string) =>
  parseJson(operation, source).pipe(
    Effect.flatMap((value) => {
      const error = decodeErrorEnvelopeOption(value);
      if (Option.isSome(error))
        return Effect.fail(
          processError(
            operation,
            error.value.error.code,
            error.value.error.message.slice(0, 1_024),
          ),
        );
      return decodeEnvelopeEffect(value).pipe(
        Effect.mapError(() =>
          protocolError(
            operation,
            "herdr_protocol_invalid",
            `Herdr returned an invalid envelope for ${operation}.`,
          ),
        ),
        Effect.map((envelope) => envelope.result),
      );
    }),
  );

const decodeResult =
  <S extends Schema.ConstraintDecoder<unknown>>(
    schema: S,
    operation: string,
    invalidMessage: string,
  ) =>
  (source: string) =>
    decodeEnvelope(operation, source).pipe(
      Effect.flatMap((result) =>
        Schema.decodeUnknownEffect(schema)(result).pipe(
          Effect.mapError(() => protocolError(operation, "herdr_protocol_invalid", invalidMessage)),
        ),
      ),
    );

const paneView = (pane: typeof PaneSchema.Type): HerdrPane => ({
  paneId: pane.pane_id,
  terminalId: pane.terminal_id,
  workspaceId: pane.workspace_id,
  tabId: pane.tab_id,
  ...(pane.cwd && { cwd: pane.cwd }),
  ...(pane.foreground_cwd && { foregroundCwd: pane.foreground_cwd }),
  agentStatus: pane.agent_status,
});
const agentView = (agent: typeof AgentSchema.Type): HerdrAgent => ({
  ...paneView(agent),
  ...(agent.name && { name: agent.name }),
  ...(agent.agent && { runtime: agent.agent }),
  stateChangeSequence: agent.state_change_seq ?? 0,
  ...(agent.interactive_ready !== undefined && {
    interactiveReady: agent.interactive_ready,
  }),
  ...(agent.agent_session && { agentSession: { ...agent.agent_session } }),
});

const decodeSnapshot = (source: string) =>
  decodeResult(
    SnapshotEnvelopeSchema,
    "session snapshot",
    "Herdr returned an invalid bounded snapshot.",
  )(source).pipe(
    Effect.map(
      ({ snapshot }): HerdrSnapshot => ({
        protocol: snapshot.protocol,
        workspaces: snapshot.workspaces.map((workspace) => ({
          workspaceId: workspace.workspace_id,
        })),
        tabs: snapshot.tabs.map((tab) => ({ tabId: tab.tab_id, workspaceId: tab.workspace_id })),
        panes: snapshot.panes.map(paneView),
        agents: snapshot.agents.map(agentView),
      }),
    ),
  );

const decodeAgentResponse = (operation: string, source: string) =>
  decodeResult(
    AgentEnvelopeSchema,
    operation,
    `Herdr returned invalid agent evidence for ${operation}.`,
  )(source).pipe(Effect.map(({ agent }) => agentView(agent)));

export const makeHerdrCli = (options: HerdrCliLayerOptions = {}): HerdrCliContract => {
  // Select, sanitize, and clone ambient session/auth routing exactly once. No later process.env
  // mutation can redirect any command or native readiness probe owned by this service.
  const environment = pickEnvironment(
    options.environment ?? process.env,
    HERDR_CLI_ENVIRONMENT_KEYS,
  );
  const fixedOptions: HerdrCliLayerOptions = Object.freeze({ ...options, environment });
  const callingPaneId =
    environment.HERDR_ENV === "1" && environment.HERDR_PANE_ID
      ? environment.HERDR_PANE_ID
      : undefined;
  const ok = (args: ReadonlyArray<string>, operation: string) =>
    runCommand(fixedOptions, args, operation).pipe(
      Effect.flatMap((source) => decodeEnvelope(operation, source)),
      Effect.asVoid,
    );
  const asReadiness = (error: SubagentProcessError) =>
    readinessError(error.code ?? "herdr_unavailable", error.message);
  const currentPane = runCommand(
    fixedOptions,
    ["pane", "current", "--current"],
    "resolve calling pane",
  ).pipe(
    Effect.flatMap(
      decodeResult(
        PaneEnvelopeSchema,
        "resolve calling pane",
        "Herdr returned invalid calling-pane ownership evidence.",
      ),
    ),
    Effect.map(({ pane }) => paneView(pane)),
  );

  const preflight: HerdrCliContract["preflight"] = (runtime) =>
    Effect.gen(function* () {
      if (!environment.HERDR_SOCKET_PATH)
        return yield* readinessError(
          "herdr_socket_required",
          "Herdr subagents require the inherited HERDR_SOCKET_PATH so sterile native harnesses can report lifecycle and session identity to the same server.",
        );
      if (!callingPaneId)
        return yield* readinessError(
          "herdr_calling_pane_required",
          "Herdr subagents require Pi to run inside a resolvable Herdr pane so launches can stay in the calling workspace and tab.",
        );
      if (Object.values(environment).some((value) => value && hasControlCharacter(value)))
        return yield* readinessError(
          "herdr_environment_invalid",
          "The bounded inherited Herdr CLI environment contains unsupported control characters.",
        );
      const schemaSource = yield* runCommand(
        fixedOptions,
        ["api", "schema", "--json"],
        "inspect Herdr protocol",
      ).pipe(Effect.mapError(asReadiness));
      const document = yield* parseJson("inspect Herdr protocol", schemaSource).pipe(
        Effect.flatMap(decodeSchemaDocumentEffect),
        Effect.mapError(() =>
          readinessError("herdr_schema_invalid", "Herdr returned an invalid protocol schema."),
        ),
      );
      if (!SUPPORTED_PROTOCOLS.some((protocol) => protocol === document.protocol))
        return yield* readinessError(
          document.protocol < SUPPORTED_PROTOCOLS[0]
            ? "herdr_upgrade_required"
            : "herdr_protocol_unsupported",
          `Unsupported Herdr protocol ${document.protocol}. pi-subagents supports protocols ${SUPPORTED_PROTOCOLS.join(" and ")}; Herdr launch was blocked before topology changes.`,
        );
      const liveSnapshot = yield* runCommand(
        fixedOptions,
        ["api", "snapshot"],
        "inspect live Herdr session",
      ).pipe(Effect.flatMap(decodeSnapshot), Effect.mapError(asReadiness));
      if (liveSnapshot.protocol !== document.protocol)
        return yield* readinessError(
          "herdr_protocol_mismatch",
          `Unsupported Herdr protocol pairing. The CLI reports ${document.protocol}, but the live server reports ${liveSnapshot.protocol}. pi-subagents requires one matching supported protocol; Herdr launch was blocked before topology changes.`,
        );
      const resolvedCallingPane = yield* currentPane.pipe(
        Effect.mapError((error) =>
          readinessError(
            "herdr_calling_pane_unresolvable",
            `The inherited Herdr calling pane could not be resolved: ${error.message}`,
          ),
        ),
      );
      if (
        resolvedCallingPane.paneId !== callingPaneId ||
        !exactPaneContext(resolvedCallingPane, liveSnapshot)
      )
        return yield* readinessError(
          "herdr_calling_pane_unresolvable",
          "The inherited Herdr calling pane did not match one exact live pane/terminal/workspace/tab tuple.",
        );
      const integrations = yield* runCommand(
        fixedOptions,
        ["integration", "status"],
        "inspect Herdr integrations",
        fixedOptions.commandTimeoutMillis,
        MAX_TEXT_BYTES,
      ).pipe(Effect.mapError(asReadiness));
      const line = integrations
        .split(/\r?\n/u)
        .find((candidate) => candidate.startsWith(`${runtime}:`));
      if (!line || !/^\w+: current \(v\d+\) \(.+\)$/u.test(line))
        return yield* readinessError(
          `${runtime}_herdr_integration_unavailable`,
          `The current Herdr ${runtime} integration is required before topology can be created.`,
        );
      const nativeArgs = runtime === "claude" ? ["auth", "status", "--json"] : ["--version"];
      const native = yield* runEffect(
        fixedOptions.runtimeExecutables?.[runtime] ?? runtime,
        nativeArgs,
        environment,
        5_000,
        32 * 1024,
      ).pipe(
        Effect.mapError(() =>
          readinessError(
            `${runtime}_preflight_failed`,
            `Unable to run the bounded ${runtime} native readiness probe.`,
          ),
        ),
      );
      yield* validateNativePreflight(runtime, native);
    });

  return {
    callingPaneId,
    preflight,
    snapshot: runCommand(fixedOptions, ["api", "snapshot"], "session snapshot").pipe(
      Effect.flatMap(decodeSnapshot),
    ),
    currentPane,
    splitPane: (paneId, cwd) =>
      runCommand(
        fixedOptions,
        ["pane", "split", paneId, "--direction", "right", "--cwd", cwd, "--no-focus"],
        "split pane",
      ).pipe(
        Effect.flatMap(
          decodeResult(
            PaneEnvelopeSchema,
            "split pane",
            "Herdr returned invalid pane ownership evidence.",
          ),
        ),
        Effect.map(({ pane }) => paneView(pane)),
      ),
    renamePane: (paneId, label) => ok(["pane", "rename", paneId, label], "rename pane"),
    runPaneCommand: (paneId, command, operation) =>
      runCommand(
        fixedOptions,
        ["pane", "run", paneId, command],
        operation,
        undefined,
        MAX_TEXT_BYTES,
      ).pipe(
        // Herdr 0.8 intentionally emits no JSON for a successful `pane run`. Private filesystem
        // receipts attest startup command execution because rendered terminal output is ephemeral.
        // Preserve envelope validation if a compatible server does emit a response.
        Effect.flatMap((source) =>
          source.trim().length === 0
            ? Effect.void
            : decodeEnvelope(operation, source).pipe(Effect.asVoid),
        ),
      ),
    paneProcessInfo: (paneId) =>
      runCommand(
        fixedOptions,
        ["pane", "process-info", "--pane", paneId],
        "inspect pane shell",
      ).pipe(
        Effect.flatMap(
          decodeResult(
            PaneProcessInfoEnvelopeSchema,
            "inspect pane shell",
            "Herdr returned invalid bounded pane process information.",
          ),
        ),
        Effect.map(
          ({ process_info: info }): HerdrPaneProcessInfo => ({
            paneId: info.pane_id,
            ...(info.shell_pid && { shellPid: info.shell_pid }),
            ...(info.foreground_process_group_id && {
              foregroundProcessGroupId: info.foreground_process_group_id,
            }),
            foregroundProcesses: (info.foreground_processes ?? []).map((process) => ({
              pid: process.pid,
              name: process.name,
            })),
          }),
        ),
      ),
    startAgent: (input) =>
      runCommand(
        fixedOptions,
        [
          "agent",
          "start",
          input.agentName,
          "--kind",
          input.runtime,
          "--pane",
          input.paneId,
          "--timeout",
          "60000",
          "--",
          ...input.argv,
        ],
        "start agent",
        START_TIMEOUT_MILLIS,
        MAX_JSON_BYTES,
        CONFIRMED_AGENT_START_REJECTION_CODES,
      ).pipe(Effect.flatMap((source) => decodeAgentResponse("start agent", source))),
    prompt: (agentName, text) =>
      runCommand(
        fixedOptions,
        ["agent", "prompt", agentName, text],
        "prompt agent",
        undefined,
        MAX_JSON_BYTES,
        CONFIRMED_AGENT_PROMPT_REJECTION_CODES,
      ).pipe(Effect.flatMap((source) => decodeAgentResponse("prompt agent", source))),
    closePane: (paneId) => ok(["pane", "close", paneId], "close pane"),
  };
};

export class HerdrCli extends Context.Service<HerdrCli, HerdrCliContract>()(
  "pi-subagents/boundary/herdr-cli/HerdrCli",
) {
  static readonly layer = (options: HerdrCliLayerOptions = {}): Layer.Layer<HerdrCli> =>
    Layer.succeed(this, makeHerdrCli(options));
}
