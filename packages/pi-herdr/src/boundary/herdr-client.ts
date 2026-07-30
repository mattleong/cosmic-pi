// Herdr CLI ownership is intentionally isolated at this Node boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/processEnvInEffect:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import { spawn } from "node:child_process";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import { HerdrConfigStore } from "../config/store.ts";
import { HerdrCommandError, HerdrProtocolError, HerdrUnavailableError } from "../herd/errors.ts";
import {
  decodeAgent,
  decodeAgents,
  decodeHerdrErrorOption,
  decodeOk,
  decodePane,
  decodeSnapshot,
  decodeTabCreated,
  decodeWorkspaceCreated,
} from "../herd/protocol.ts";
import type {
  HerdrCreatedTab,
  HerdrCreatedWorkspace,
  HerdrPaneInfo,
  HerdrReadSource,
  HerdrRemoteAgentInfo,
  HerdrSnapshot,
} from "../herd/model.ts";

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const COMMAND_TIMEOUT = "30 seconds";
const START_COMMAND_TIMEOUT = "70 seconds";
const MINIMUM_PROTOCOL = 17;
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"] as const;
const DISALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "MultiEdit",
  "Agent",
  "Task",
  "Workflow",
] as const;
const REPORT_TOOL = "mcp__herdr_report__submit_report";

const SchemaDocument = Schema.Struct({ protocol: Schema.Number, schema_version: Schema.Number });

export interface HerdrClientShape {
  readonly sessionIdentity: string;
  readonly preflight: Effect.Effect<void, HerdrUnavailableError | HerdrProtocolError>;
  readonly snapshot: Effect.Effect<HerdrSnapshot, HerdrCommandError | HerdrProtocolError>;
  readonly createWorkspace: (
    cwd: string,
    label: string,
  ) => Effect.Effect<HerdrCreatedWorkspace, HerdrCommandError | HerdrProtocolError>;
  readonly renameTab: (
    tabId: string,
    label: string,
  ) => Effect.Effect<void, HerdrCommandError | HerdrProtocolError>;
  readonly createTab: (
    workspaceId: string,
    cwd: string,
    label: string,
  ) => Effect.Effect<HerdrCreatedTab, HerdrCommandError | HerdrProtocolError>;
  readonly splitPane: (
    paneId: string,
    cwd: string,
    direction: "right" | "down",
  ) => Effect.Effect<HerdrPaneInfo, HerdrCommandError | HerdrProtocolError>;
  readonly renamePane: (
    paneId: string,
    label: string,
  ) => Effect.Effect<void, HerdrCommandError | HerdrProtocolError>;
  readonly startClaude: (input: {
    readonly paneId: string;
    readonly name: string;
    readonly mcpConfigPath: string;
  }) => Effect.Effect<HerdrRemoteAgentInfo, HerdrCommandError | HerdrProtocolError>;
  readonly prompt: (
    target: string,
    text: string,
  ) => Effect.Effect<HerdrRemoteAgentInfo, HerdrCommandError | HerdrProtocolError>;
  readonly listAgents: Effect.Effect<
    ReadonlyArray<HerdrRemoteAgentInfo>,
    HerdrCommandError | HerdrProtocolError
  >;
  readonly readAgent: (
    target: string,
    source: HerdrReadSource,
    lines: number,
  ) => Effect.Effect<string, HerdrCommandError>;
  readonly closePane: (
    paneId: string,
  ) => Effect.Effect<void, HerdrCommandError | HerdrProtocolError>;
  readonly focusTab: (tabId: string) => Effect.Effect<void, HerdrCommandError | HerdrProtocolError>;
  readonly focusAgent: (
    target: string,
  ) => Effect.Effect<void, HerdrCommandError | HerdrProtocolError>;
}

export interface HerdrClientOptions {
  readonly session?: string | undefined;
  readonly command?: string | undefined;
}

interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

const safeEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && key !== "NODE_OPTIONS" && key !== "NODE_PATH",
    ),
  );

const boundedAppend = (current: string, chunk: Buffer, maximum: number): string => {
  const next = Buffer.concat([Buffer.from(current, "utf8"), chunk]);
  if (next.byteLength <= maximum) return next.toString("utf8");
  return next.subarray(next.byteLength - maximum).toString("utf8");
};

const commandFailure = (operation: string, code: number | null) =>
  new HerdrCommandError({
    operation,
    code: code === 2 ? "herdr_cli_usage" : "herdr_cli_failed",
    message: `Herdr command failed during ${operation}${code === null ? "" : ` (exit ${code})`}.`,
  });

const runCommand = (
  command: string,
  args: ReadonlyArray<string>,
  operation: string,
  maximumBytes = MAX_JSON_BYTES,
  timeout: Duration.Input = COMMAND_TIMEOUT,
): Effect.Effect<CommandOutput, HerdrCommandError> =>
  Effect.callback<CommandOutput, HerdrCommandError>((resume, signal) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let overflowed = false;
    let child;
    const finish = (effect: Effect.Effect<CommandOutput, HerdrCommandError>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    try {
      child = spawn(command, [...args], {
        env: safeEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      finish(Effect.fail(commandFailure(operation, null)));
      return Effect.void;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stdout, "utf8") + chunk.byteLength > maximumBytes) {
        overflowed = true;
        child.kill();
      }
      stdout = boundedAppend(stdout, chunk, maximumBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = boundedAppend(stderr, chunk, 8 * 1024);
    });
    child.once("error", () => finish(Effect.fail(commandFailure(operation, null))));
    child.once("close", (code) => {
      if (overflowed) {
        finish(
          Effect.fail(
            new HerdrCommandError({
              operation,
              code: "herdr_output_too_large",
              message: `Herdr output exceeded its bounded limit during ${operation}.`,
            }),
          ),
        );
        return;
      }
      if (code !== 0) {
        try {
          const structured = decodeHerdrErrorOption(operation, JSON.parse(stderr) as unknown);
          if (Option.isSome(structured)) {
            finish(Effect.fail(structured.value));
            return;
          }
        } catch {
          // Usage and process errors are not guaranteed to be JSON.
        }
        const diagnostic = sanitizeDiagnosticContent(stderr, { maximumLength: 512 });
        finish(
          Effect.fail(
            new HerdrCommandError({
              operation,
              code: code === 2 ? "herdr_cli_usage" : "herdr_cli_failed",
              message: diagnostic
                ? `Herdr command failed during ${operation}: ${diagnostic}`
                : `Herdr command failed during ${operation}${code === null ? "" : ` (exit ${code})`}.`,
            }),
          ),
        );
        return;
      }
      finish(Effect.succeed({ stdout, stderr, code }));
    });
    if (signal.aborted) child.kill();
    else signal.addEventListener("abort", () => child.kill(), { once: true });
    return Effect.sync(() => {
      if (!settled) child.kill();
    });
  }).pipe(
    Effect.timeoutOption(timeout),
    Effect.flatMap((outcome) =>
      Option.isSome(outcome)
        ? Effect.succeed(outcome.value)
        : Effect.fail(
            new HerdrCommandError({
              operation,
              code: "herdr_cli_timeout",
              message: `Herdr command timed out during ${operation}.`,
            }),
          ),
    ),
  );

const parseJson = (operation: string, source: string): Effect.Effect<unknown, HerdrProtocolError> =>
  Effect.try({
    try: () => JSON.parse(source) as unknown,
    catch: () =>
      new HerdrProtocolError({
        operation,
        code: "herdr_json_invalid",
        message: `Herdr returned invalid JSON for ${operation}.`,
      }),
  });

const READ_ONLY_SYSTEM_PROMPT = [
  "You are a read-only delegated Claude Code agent managed by pi-herdr.",
  "Do not modify the project, run shell commands, create subagents, or request permission to mutate files.",
  "Use only the supplied read and web tools. Complete the assigned task independently.",
  "Before your final response, call mcp__herdr_report__submit_report exactly once with the complete final report and status completed, blocked, or failed.",
  "Do not ask the user to copy, save, locate, or manage a report artifact.",
].join(" ");

export const buildClaudePromptArgs = (target: string, text: string): ReadonlyArray<string> => [
  "agent",
  "prompt",
  target,
  text,
];

export const buildClaudeStartArgs = (input: {
  readonly paneId: string;
  readonly name: string;
  readonly mcpConfigPath: string;
}): ReadonlyArray<string> => [
  "agent",
  "start",
  input.name,
  "--kind",
  "claude",
  "--pane",
  input.paneId,
  "--timeout",
  "60000",
  "--",
  "--name",
  input.name,
  "--no-chrome",
  "--disable-slash-commands",
  "--setting-sources",
  "user",
  "--mcp-config",
  input.mcpConfigPath,
  "--strict-mcp-config",
  "--tools",
  READ_ONLY_TOOLS.join(","),
  "--allowedTools",
  [...READ_ONLY_TOOLS, REPORT_TOOL].join(","),
  "--disallowedTools",
  DISALLOWED_TOOLS.join(","),
  "--permission-mode",
  "dontAsk",
  "--append-system-prompt",
  READ_ONLY_SYSTEM_PROMPT,
];

export class HerdrClient extends Context.Service<HerdrClient, HerdrClientShape>()(
  "pi-herdr/boundary/herdr-client/HerdrClient",
) {
  static readonly layer = (options: HerdrClientOptions = {}) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const store = yield* HerdrConfigStore;
        const selectedSession = options.session ?? store.config.session;
        const command = options.command ?? "herdr";
        const prefix = selectedSession ? ["--session", selectedSession] : [];
        const sessionIdentity =
          selectedSession ??
          process.env.HERDR_SOCKET_PATH ??
          process.env.HERDR_SESSION ??
          "default";
        const json = (
          args: ReadonlyArray<string>,
          operation: string,
          timeout: Duration.Input = COMMAND_TIMEOUT,
        ) =>
          runCommand(command, [...prefix, ...args], operation, MAX_JSON_BYTES, timeout).pipe(
            Effect.flatMap((output) => parseJson(operation, output.stdout)),
          );
        const ok = (args: ReadonlyArray<string>, operation: string) =>
          json(args, operation).pipe(Effect.flatMap((value) => decodeOk(operation, value)));

        const preflight: HerdrClientShape["preflight"] = json(
          ["api", "schema", "--json"],
          "inspect Herdr protocol",
        ).pipe(
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(SchemaDocument)(value).pipe(
              Effect.mapError(
                () =>
                  new HerdrProtocolError({
                    operation: "inspect Herdr protocol",
                    code: "herdr_schema_invalid",
                    message: "Herdr returned an invalid protocol schema.",
                  }),
              ),
            ),
          ),
          Effect.flatMap((document) =>
            document.protocol >= MINIMUM_PROTOCOL
              ? Effect.void
              : Effect.fail(
                  new HerdrUnavailableError({
                    code: "herdr_upgrade_required",
                    message: `pi-herdr requires Herdr protocol ${MINIMUM_PROTOCOL} or newer (Herdr 0.7.5+); found protocol ${document.protocol}. Upgrade Herdr and restart its server.`,
                  }),
                ),
          ),
          Effect.mapError((error) =>
            error instanceof HerdrUnavailableError || error instanceof HerdrProtocolError
              ? error
              : new HerdrUnavailableError({
                  code: "herdr_unavailable",
                  message:
                    "Unable to connect to the selected Herdr session. Start Herdr and retry.",
                }),
          ),
        );

        const snapshot = json(["api", "snapshot"], "session snapshot").pipe(
          Effect.flatMap(decodeSnapshot),
        );
        const createWorkspace: HerdrClientShape["createWorkspace"] = (cwd, label) =>
          json(
            ["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"],
            "create workspace",
          ).pipe(Effect.flatMap(decodeWorkspaceCreated));
        const renameTab: HerdrClientShape["renameTab"] = (tabId, label) =>
          ok(["tab", "rename", tabId, label], "rename tab");
        const createTab: HerdrClientShape["createTab"] = (workspaceId, cwd, label) =>
          json(
            [
              "tab",
              "create",
              "--workspace",
              workspaceId,
              "--cwd",
              cwd,
              "--label",
              label,
              "--no-focus",
            ],
            "create tab",
          ).pipe(Effect.flatMap(decodeTabCreated));
        const splitPane: HerdrClientShape["splitPane"] = (paneId, cwd, direction) =>
          json(
            ["pane", "split", paneId, "--direction", direction, "--cwd", cwd, "--no-focus"],
            "split pane",
          ).pipe(Effect.flatMap((value) => decodePane("split pane", value)));
        const renamePane: HerdrClientShape["renamePane"] = (paneId, label) =>
          ok(["pane", "rename", paneId, label], "rename pane");
        const startClaude: HerdrClientShape["startClaude"] = (input) =>
          json(buildClaudeStartArgs(input), "start Claude Code", START_COMMAND_TIMEOUT).pipe(
            Effect.flatMap((value) => decodeAgent("start Claude Code", value)),
          );
        const prompt: HerdrClientShape["prompt"] = (target, text) =>
          json(buildClaudePromptArgs(target, text), "prompt Claude Code").pipe(
            Effect.flatMap((value) => decodeAgent("prompt Claude Code", value)),
          );
        const listAgents = json(["agent", "list"], "list agents").pipe(
          Effect.flatMap(decodeAgents),
        );
        const readAgent: HerdrClientShape["readAgent"] = (target, source, lines) =>
          runCommand(
            command,
            [...prefix, "agent", "read", target, "--source", source, "--lines", String(lines)],
            "read agent",
            MAX_TEXT_BYTES,
          ).pipe(Effect.map((output) => output.stdout));
        const closePane: HerdrClientShape["closePane"] = (paneId) =>
          ok(["pane", "close", paneId], "close pane");
        const focusTab: HerdrClientShape["focusTab"] = (tabId) =>
          ok(["tab", "focus", tabId], "restore tab focus");
        const focusAgent: HerdrClientShape["focusAgent"] = (target) =>
          ok(["agent", "focus", target], "focus agent");

        return HerdrClient.of({
          sessionIdentity,
          preflight,
          snapshot,
          createWorkspace,
          renameTab,
          createTab,
          splitPane,
          renamePane,
          startClaude,
          prompt,
          listAgents,
          readAgent,
          closePane,
          focusTab,
          focusAgent,
        });
      }),
    );
}
