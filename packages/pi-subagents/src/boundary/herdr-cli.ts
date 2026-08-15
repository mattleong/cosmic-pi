// Herdr CLI process ownership and inherited-session selection are isolated at this boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import { spawn, type ChildProcess as NodeChildProcess } from "node:child_process";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { HerdrPaneProcessInfo } from "../backend/herdr-shell-readiness.ts";
import { InvalidSubagentRequestError, SubagentProcessError } from "../run/errors.ts";
import type { SubagentRuntime } from "../domain/routing.ts";

const HERDR_EXECUTABLE = "herdr";
const SUPPORTED_PROTOCOL = 19;
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
const MUTATING_OPERATIONS = new Set([
  "create workspace",
  "split pane",
  "rename pane",
  "activate pane input",
  "confirm pane shell",
  "prepare pane environment",
  "load pane secrets",
  "start agent",
  "prompt agent",
  "close pane",
  "close workspace",
  "activate herdr tab",
  "restore focus",
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

export interface HerdrPane {
  readonly paneId: string;
  readonly terminalId: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly cwd?: string | undefined;
  readonly foregroundCwd?: string | undefined;
  readonly label?: string | undefined;
  readonly focused: boolean;
  readonly agentStatus: "idle" | "working" | "blocked" | "done" | "unknown";
}

export interface HerdrAgentSession {
  readonly source: string;
  readonly agent: string;
  readonly kind: "id" | "path";
  readonly value: string;
}

export interface HerdrAgent extends HerdrPane {
  readonly name?: string | undefined;
  readonly runtime?: string | undefined;
  readonly stateChangeSequence: number;
  readonly interactiveReady?: boolean | undefined;
  readonly agentSession?: HerdrAgentSession | undefined;
  readonly nativeSession?: string | undefined;
}

export interface HerdrSnapshot {
  readonly version: string;
  readonly protocol: number;
  readonly focusedWorkspaceId?: string | undefined;
  readonly focusedTabId?: string | undefined;
  readonly focusedPaneId?: string | undefined;
  readonly workspaces: ReadonlyArray<{
    readonly workspaceId: string;
    readonly label: string;
    readonly focused: boolean;
    readonly activeTabId: string;
  }>;
  readonly tabs: ReadonlyArray<{
    readonly tabId: string;
    readonly workspaceId: string;
    readonly label: string;
    readonly paneCount: number;
    readonly focused: boolean;
  }>;
  readonly panes: ReadonlyArray<HerdrPane>;
  readonly agents: ReadonlyArray<HerdrAgent>;
}

export interface HerdrCreatedWorkspace {
  readonly workspaceId: string;
  readonly workspaceLabel: string;
  readonly tabId: string;
  readonly tabLabel: string;
  readonly rootPane: HerdrPane;
}

export interface HerdrCliShape {
  /** The inherited Herdr socket identity used by launch-ready candidates. Never configured publicly. */
  readonly sessionIdentity: string;
  readonly preflight: (
    runtime: SubagentRuntime,
  ) => Effect.Effect<void, InvalidSubagentRequestError>;
  readonly snapshot: Effect.Effect<HerdrSnapshot, SubagentProcessError>;
  readonly createWorkspace: (
    cwd: string,
    label: string,
  ) => Effect.Effect<HerdrCreatedWorkspace, SubagentProcessError>;
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
  readonly waitPaneOutput: (
    paneId: string,
    marker: string,
    operation:
      | "confirm pane input"
      | "confirm pane shell"
      | "confirm pane environment"
      | "confirm pane secrets",
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
  readonly closeWorkspace: (workspaceId: string) => Effect.Effect<void, SubagentProcessError>;
  readonly focusTab: (
    tabId: string,
    operation: "activate herdr tab" | "restore focus",
  ) => Effect.Effect<void, SubagentProcessError>;
}

export interface HerdrCliLayerOptions {
  /** Test seam only. Production always uses the fixed `herdr` executable. */
  readonly executable?: string | undefined;
  /** Test seam only. Production inherits only the bounded Herdr session environment. */
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly commandTimeoutMillis?: number | undefined;
  /** Diagnostic seam only. Production uses the source selected by the real-shell regression. */
  readonly paneOutputSource?: "recent" | "recent-unwrapped" | undefined;
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

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });

const inheritedEnvironment = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.freeze(
    Object.fromEntries(
      [
        "HOME",
        "USER",
        "LOGNAME",
        "PATH",
        "SHELL",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "XDG_CONFIG_HOME",
        "XDG_STATE_HOME",
        "HERDR_CONFIG_PATH",
        "HERDR_SOCKET_PATH",
        "HERDR_SESSION",
        "PI_CODING_AGENT_DIR",
        "PI_CONFIG_DIR",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
      ].flatMap((key) => (source[key] === undefined ? [] : ([[key, source[key]]] as const))),
    ),
  );

const processError = (operation: string, code: string, message: string) =>
  new SubagentProcessError({ operation, code, message });
const readinessError = (code: string, message: string) =>
  new InvalidSubagentRequestError({ code, message });

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

interface BoundedChunks {
  readonly chunks: Buffer[];
  length: number;
}

const boundedAppend = (target: BoundedChunks, chunk: Buffer, maximum: number): void => {
  const room = maximum - target.length;
  if (room <= 0) return;
  const accepted = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
  target.chunks.push(accepted);
  target.length += accepted.byteLength;
};

const terminateProbe = (child: NodeChildProcess): Promise<boolean> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), 1_000);
    timer.unref();
    child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
    child.kill("SIGKILL");
  });

const run = (
  executable: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  timeoutMillis: number,
  maximumBytes: number,
): Promise<CommandResult> =>
  new Promise((resolve) => {
    const stdout: BoundedChunks = { chunks: [], length: 0 };
    const stderr: BoundedChunks = { chunks: [], length: 0 };
    let overflowed = false;
    let observedBytes = 0;
    let timedOut = false;
    let cleanupUnconfirmed = false;
    let dispatched = false;
    let settled = false;
    let child: NodeChildProcess;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout.chunks).toString("utf8"),
        stderr: Buffer.concat(stderr.chunks).toString("utf8"),
        overflowed,
        timedOut,
        cleanupUnconfirmed,
        dispatched,
      });
    };
    try {
      child = spawn(executable, [...args], {
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      finish(null);
      return;
    }
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      observedBytes += chunk.byteLength;
      if (observedBytes > maximumBytes) {
        overflowed = true;
        child.kill();
        return;
      }
      if (target === "stdout") boundedAppend(stdout, chunk, maximumBytes);
      else boundedAppend(stderr, chunk, MAX_DIAGNOSTIC_BYTES);
    };
    child.once("spawn", () => {
      dispatched = true;
    });
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
    timer = setTimeout(() => {
      timedOut = true;
      void terminateProbe(child).then((confirmed) => {
        cleanupUnconfirmed = !confirmed;
        finish(null);
      });
    }, timeoutMillis);
    timer.unref();
  });

const runCommand = (
  options: HerdrCliLayerOptions,
  args: ReadonlyArray<string>,
  operation: string,
  timeoutMillis = options.commandTimeoutMillis ?? COMMAND_TIMEOUT_MILLIS,
  maximumBytes = MAX_JSON_BYTES,
  confirmedRejectionCodes?: ReadonlySet<string>,
): Effect.Effect<string, SubagentProcessError> => {
  const command = Effect.tryPromise({
    try: () =>
      run(
        options.executable ?? HERDR_EXECUTABLE,
        args,
        options.environment ?? {},
        timeoutMillis,
        maximumBytes,
      ),
    catch: () => processError(operation, "herdr_cli_failed", `Herdr failed during ${operation}.`),
  }).pipe(
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
        try {
          const value = JSON.parse(result.stderr) as unknown;
          const decoded = Schema.decodeUnknownOption(ErrorEnvelopeSchema)(value);
          if (Option.isSome(decoded)) {
            code = decoded.value.error.code.slice(0, 128);
            message = decoded.value.error.message.slice(0, 1_024);
            confirmedRejection = confirmedRejectionCodes?.has(code) === true;
          }
        } catch {
          // Herdr usage/process failures are not guaranteed to be JSON. Never retain raw stderr.
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
  Effect.try({
    try: () => JSON.parse(source) as unknown,
    catch: () =>
      protocolError(
        operation,
        "herdr_json_invalid",
        `Herdr returned invalid JSON for ${operation}.`,
      ),
  });

const decodeEnvelope = (operation: string, source: string) =>
  parseJson(operation, source).pipe(
    Effect.flatMap((value) => {
      const error = Schema.decodeUnknownOption(ErrorEnvelopeSchema)(value);
      if (Option.isSome(error))
        return Effect.fail(
          processError(
            operation,
            error.value.error.code,
            error.value.error.message.slice(0, 1_024),
          ),
        );
      return Schema.decodeUnknownEffect(EnvelopeSchema)(value).pipe(
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

const paneView = (pane: Schema.Schema.Type<typeof PaneSchema>): HerdrPane => ({
  paneId: pane.pane_id,
  terminalId: pane.terminal_id,
  workspaceId: pane.workspace_id,
  tabId: pane.tab_id,
  ...(pane.cwd ? { cwd: pane.cwd } : {}),
  ...(pane.foreground_cwd ? { foregroundCwd: pane.foreground_cwd } : {}),
  ...(pane.label ? { label: pane.label } : {}),
  focused: pane.focused,
  agentStatus: pane.agent_status,
});
const agentView = (agent: Schema.Schema.Type<typeof AgentSchema>): HerdrAgent => ({
  ...paneView(agent),
  ...(agent.name ? { name: agent.name } : {}),
  ...(agent.agent ? { runtime: agent.agent } : {}),
  stateChangeSequence: agent.state_change_seq ?? 0,
  ...(agent.interactive_ready === undefined ? {} : { interactiveReady: agent.interactive_ready }),
  ...(agent.agent_session
    ? {
        agentSession: {
          source: agent.agent_session.source,
          agent: agent.agent_session.agent,
          kind: agent.agent_session.kind,
          value: agent.agent_session.value,
        },
        nativeSession: agent.agent_session.value,
      }
    : {}),
});

const decodeSnapshot = (source: string) =>
  decodeEnvelope("session snapshot", source).pipe(
    Effect.flatMap((result) =>
      Schema.decodeUnknownEffect(Schema.Struct({ snapshot: SnapshotSchema }))(result).pipe(
        Effect.mapError(() =>
          processError(
            "session snapshot",
            "herdr_protocol_invalid",
            "Herdr returned an invalid bounded snapshot.",
          ),
        ),
      ),
    ),
    Effect.map(
      ({ snapshot }) =>
        ({
          version: snapshot.version,
          protocol: snapshot.protocol,
          ...(snapshot.focused_workspace_id
            ? { focusedWorkspaceId: snapshot.focused_workspace_id }
            : {}),
          ...(snapshot.focused_tab_id ? { focusedTabId: snapshot.focused_tab_id } : {}),
          ...(snapshot.focused_pane_id ? { focusedPaneId: snapshot.focused_pane_id } : {}),
          workspaces: snapshot.workspaces.map((workspace) => ({
            workspaceId: workspace.workspace_id,
            label: workspace.label,
            focused: workspace.focused,
            activeTabId: workspace.active_tab_id,
          })),
          tabs: snapshot.tabs.map((tab) => ({
            tabId: tab.tab_id,
            workspaceId: tab.workspace_id,
            label: tab.label,
            paneCount: tab.pane_count,
            focused: tab.focused,
          })),
          panes: snapshot.panes.map(paneView),
          agents: snapshot.agents.map(agentView),
        }) satisfies HerdrSnapshot,
    ),
  );

const decodeAgentResponse = (operation: string, source: string) =>
  decodeEnvelope(operation, source).pipe(
    Effect.flatMap((result) =>
      Schema.decodeUnknownEffect(Schema.Struct({ agent: AgentSchema }))(result).pipe(
        Effect.mapError(() =>
          protocolError(
            operation,
            "herdr_protocol_invalid",
            `Herdr returned invalid agent evidence for ${operation}.`,
          ),
        ),
      ),
    ),
    Effect.map(({ agent }) => agentView(agent)),
  );

export const makeHerdrCli = (options: HerdrCliLayerOptions = {}): HerdrCliShape => {
  // Select, sanitize, and clone ambient session/auth routing exactly once. No later process.env
  // mutation can redirect any command or native readiness probe owned by this service.
  const environment = inheritedEnvironment(options.environment ?? process.env);
  const fixedOptions: HerdrCliLayerOptions = Object.freeze({ ...options, environment });
  const sessionIdentity = environment.HERDR_SOCKET_PATH ?? environment.HERDR_SESSION ?? "default";
  const json = (args: ReadonlyArray<string>, operation: string, timeout?: number) =>
    runCommand(fixedOptions, args, operation, timeout).pipe(
      Effect.flatMap((source) => decodeEnvelope(operation, source)),
    );
  const ok = (args: ReadonlyArray<string>, operation: string) =>
    json(args, operation).pipe(Effect.asVoid);

  const preflight: HerdrCliShape["preflight"] = (runtime) =>
    Effect.gen(function* () {
      if (!environment.HERDR_SOCKET_PATH)
        return yield* readinessError(
          "herdr_socket_required",
          "Herdr subagents require the inherited HERDR_SOCKET_PATH so sterile native harnesses can report lifecycle and session identity to the same server.",
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
      ).pipe(
        Effect.mapError((error) =>
          readinessError(error.code ?? "herdr_unavailable", error.message),
        ),
      );
      const document = yield* parseJson("inspect Herdr protocol", schemaSource).pipe(
        Effect.flatMap((value) => Schema.decodeUnknownEffect(SchemaDocument)(value)),
        Effect.mapError(() =>
          readinessError("herdr_schema_invalid", "Herdr returned an invalid protocol schema."),
        ),
      );
      if (document.protocol !== SUPPORTED_PROTOCOL)
        return yield* readinessError(
          document.protocol < SUPPORTED_PROTOCOL
            ? "herdr_upgrade_required"
            : "herdr_protocol_unsupported",
          `Herdr protocol ${SUPPORTED_PROTOCOL} is required; found ${document.protocol}.`,
        );
      const liveSnapshot = yield* runCommand(
        fixedOptions,
        ["api", "snapshot"],
        "inspect live Herdr session",
      ).pipe(
        Effect.flatMap(decodeSnapshot),
        Effect.mapError((error) =>
          readinessError(error.code ?? "herdr_unavailable", error.message),
        ),
      );
      if (liveSnapshot.protocol !== document.protocol)
        return yield* readinessError(
          "herdr_protocol_mismatch",
          `Herdr CLI protocol ${document.protocol} does not match the selected live server protocol ${liveSnapshot.protocol}.`,
        );
      const integrations = yield* runCommand(
        fixedOptions,
        ["integration", "status"],
        "inspect Herdr integrations",
        fixedOptions.commandTimeoutMillis,
        MAX_TEXT_BYTES,
      ).pipe(
        Effect.mapError((error) =>
          readinessError(error.code ?? "herdr_unavailable", error.message),
        ),
      );
      const line = integrations
        .split(/\r?\n/u)
        .find((candidate) => candidate.startsWith(`${runtime}:`));
      if (!line || !/^\w+: current \(v\d+\) \(.+\)$/u.test(line))
        return yield* readinessError(
          `${runtime}_herdr_integration_unavailable`,
          `The current Herdr ${runtime} integration is required before topology can be created.`,
        );
      const nativeArgs = runtime === "claude" ? ["auth", "status", "--json"] : ["--version"];
      const native = yield* Effect.tryPromise({
        try: () =>
          run(
            fixedOptions.runtimeExecutables?.[runtime] ?? runtime,
            nativeArgs,
            environment,
            5_000,
            32 * 1024,
          ),
        catch: () =>
          readinessError(
            `${runtime}_preflight_failed`,
            `Unable to run the bounded ${runtime} native readiness probe.`,
          ),
      });
      if (native.cleanupUnconfirmed)
        return yield* readinessError(
          `${runtime}_preflight_cleanup_unconfirmed`,
          `${runtime} readiness probe cleanup could not be confirmed; candidate fallback is unsafe.`,
        );
      if (native.timedOut || native.overflowed)
        return yield* readinessError(
          `${runtime}_preflight_unbounded`,
          `${runtime} readiness probe exceeded its time or output bound.`,
        );
      if (native.code !== 0)
        return yield* readinessError(
          native.code === null ? `${runtime}_executable_unavailable` : `${runtime}_unauthenticated`,
          native.code === null
            ? `${runtime} executable is unavailable.`
            : `${runtime} authentication/readiness is unavailable.`,
        );
      if (runtime === "claude")
        yield* parseJson("inspect Claude authentication", native.stdout).pipe(
          Effect.flatMap((value) => Schema.decodeUnknownEffect(ClaudeAuthStatusSchema)(value)),
          Effect.mapError(() =>
            readinessError(
              "claude_unauthenticated",
              "Claude auth status did not return bounded authenticated evidence.",
            ),
          ),
        );
    });

  return {
    sessionIdentity,
    preflight,
    snapshot: runCommand(fixedOptions, ["api", "snapshot"], "session snapshot").pipe(
      Effect.flatMap(decodeSnapshot),
    ),
    createWorkspace: (cwd, label) =>
      runCommand(
        fixedOptions,
        ["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"],
        "create workspace",
      ).pipe(
        Effect.flatMap((source) => decodeEnvelope("create workspace", source)),
        Effect.flatMap((result) =>
          Schema.decodeUnknownEffect(
            Schema.Struct({ workspace: WorkspaceSchema, tab: TabSchema, root_pane: PaneSchema }),
          )(result).pipe(
            Effect.mapError(() =>
              protocolError(
                "create workspace",
                "herdr_protocol_invalid",
                "Herdr returned invalid workspace ownership evidence.",
              ),
            ),
          ),
        ),
        Effect.map((created) => ({
          workspaceId: created.workspace.workspace_id,
          workspaceLabel: created.workspace.label,
          tabId: created.tab.tab_id,
          tabLabel: created.tab.label,
          rootPane: paneView(created.root_pane),
        })),
      ),
    splitPane: (paneId, cwd) =>
      runCommand(
        fixedOptions,
        ["pane", "split", paneId, "--direction", "right", "--cwd", cwd, "--no-focus"],
        "split pane",
      ).pipe(
        Effect.flatMap((source) => decodeEnvelope("split pane", source)),
        Effect.flatMap((result) =>
          Schema.decodeUnknownEffect(Schema.Struct({ pane: PaneSchema }))(result).pipe(
            Effect.mapError(() =>
              protocolError(
                "split pane",
                "herdr_protocol_invalid",
                "Herdr returned invalid pane ownership evidence.",
              ),
            ),
          ),
        ),
        Effect.map(({ pane }) => paneView(pane)),
      ),
    renamePane: (paneId, label) =>
      runCommand(fixedOptions, ["pane", "rename", paneId, label], "rename pane").pipe(
        Effect.flatMap((source) => decodeEnvelope("rename pane", source)),
        Effect.asVoid,
      ),
    runPaneCommand: (paneId, command, operation) =>
      runCommand(
        fixedOptions,
        ["pane", "run", paneId, command],
        operation,
        undefined,
        MAX_TEXT_BYTES,
      ).pipe(
        // Herdr 0.8 intentionally emits no JSON for a successful `pane run`; the
        // subsequent marker wait is the causal application attestation. Preserve
        // envelope validation if a compatible server does emit a response.
        Effect.flatMap((source) =>
          source.trim().length === 0
            ? Effect.void
            : decodeEnvelope(operation, source).pipe(Effect.asVoid),
        ),
      ),
    waitPaneOutput: (paneId, marker, operation) =>
      runCommand(
        fixedOptions,
        [
          "pane",
          "wait-output",
          paneId,
          "--match",
          marker,
          "--source",
          fixedOptions.paneOutputSource ?? "recent",
          "--lines",
          "40",
          "--timeout",
          "5000",
        ],
        operation,
        7_000,
        MAX_TEXT_BYTES,
      ).pipe(
        Effect.flatMap((source) => decodeEnvelope(operation, source)),
        Effect.asVoid,
      ),
    paneProcessInfo: (paneId) =>
      runCommand(
        fixedOptions,
        ["pane", "process-info", "--pane", paneId],
        "inspect pane shell",
      ).pipe(
        Effect.flatMap((source) => decodeEnvelope("inspect pane shell", source)),
        Effect.flatMap((result) =>
          Schema.decodeUnknownEffect(Schema.Struct({ process_info: PaneProcessInfoSchema }))(
            result,
          ).pipe(
            Effect.mapError(() =>
              processError(
                "inspect pane shell",
                "herdr_protocol_invalid",
                "Herdr returned invalid bounded pane process information.",
              ),
            ),
          ),
        ),
        Effect.map(({ process_info: info }) => ({
          paneId: info.pane_id,
          ...(info.shell_pid ? { shellPid: info.shell_pid } : {}),
          ...(info.foreground_process_group_id
            ? { foregroundProcessGroupId: info.foreground_process_group_id }
            : {}),
          foregroundProcesses: (info.foreground_processes ?? []).map((process) => ({
            pid: process.pid,
            name: process.name,
          })),
        })),
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
      runCommand(fixedOptions, ["agent", "prompt", agentName, text], "prompt agent").pipe(
        Effect.flatMap((source) => decodeAgentResponse("prompt agent", source)),
      ),
    closePane: (paneId) => ok(["pane", "close", paneId], "close pane"),
    closeWorkspace: (workspaceId) => ok(["workspace", "close", workspaceId], "close workspace"),
    focusTab: (tabId, operation) => ok(["tab", "focus", tabId], operation),
  };
};

export class HerdrCli extends Context.Service<HerdrCli, HerdrCliShape>()(
  "pi-subagents/boundary/herdr-cli/HerdrCli",
) {
  static readonly layer = (options: HerdrCliLayerOptions = {}): Layer.Layer<HerdrCli> =>
    Layer.succeed(this, makeHerdrCli(options));
}
