// Node process and session-file ownership is intentionally isolated at this boundary.
import { hasObjectRuntimeType, synchronousNow } from "pi-cosmic-core";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { nodeFsPromises, nodePath } from "./node-builtins.ts";
import {
  getAgentDir,
  getPackageDir,
  parseSessionEntries,
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import {
  PI_CHILD_COMPETING_ORCHESTRATOR_TOOL_ARGUMENT,
  SUBAGENT_TOOL_NAMES,
} from "../run/tool-policy.ts";
import { processCauseError as processError, SubagentProcessError } from "../run/errors.ts";
import type { RuntimeApiKey } from "../run/model.ts";
import { acquireProcessTransport, type ProcessTransportRuntime } from "./process-transport.ts";
export { releaseChildProcess, type ChildProcessReleaseOperations } from "./process-transport.ts";
import { attachLocalPiParentIpc } from "./local-pi-ipc.ts";
import type {
  LocalPiContact,
  LocalPiParentControl,
  RpcCommand,
} from "../backend/local-pi-protocol.ts";
import type { SubagentContextMode, SubagentEffort } from "../domain/routing.ts";

const { mkdir, readFile, rm, rmdir, writeFile } = nodeFsPromises;
const { join } = nodePath;

const RUNTIME_API_KEY_ENV = "PI_SUBAGENT_RUNTIME_API_KEY";
const RUNTIME_API_PROVIDER_ENV = "PI_SUBAGENT_RUNTIME_API_PROVIDER";
const BLOCKED_ENV_KEYS = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "PI_SESSION_FILE",
  "PI_SESSION_ID",
  RUNTIME_API_KEY_ENV,
  RUNTIME_API_PROVIDER_ENV,
]);

export interface ChildLaunchRequest {
  readonly runId: string;
  readonly name: string;
  readonly cwd: string;
  readonly context: SubagentContextMode;
  readonly writeIntent: import("../domain/routing.ts").SubagentWriteIntent;
  readonly openaiFastMode: boolean;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly runtimeApiKey?: RuntimeApiKey | undefined;
  readonly activeTools: ReadonlyArray<string>;
  readonly projectTrusted: boolean;
  readonly parentSessionId: string;
  readonly parentSessionFile?: string;
  readonly parentLeafId?: string;
  readonly resumeSessionFile?: string | undefined;
  readonly systemPrompt: string;
}

export type ChildWireEvent =
  | { readonly type: "rpc_message"; readonly value: unknown }
  | { readonly type: "parent_contact"; readonly value: LocalPiContact }
  | { readonly type: "protocol_error"; readonly message: string }
  | {
      readonly type: "exit";
      readonly exitCode: number | null;
      readonly signal?: string;
      readonly stderr: string;
    };

export interface ChildProcessHandle {
  readonly pid: number;
  readonly events: Queue.Dequeue<ChildWireEvent, Cause.Done>;
  /** Release byte-weighted transport backlog ownership after one event is processed. */
  readonly acknowledge?: ((event: ChildWireEvent) => void) | undefined;
  readonly awaitExit: Effect.Effect<
    Extract<ChildWireEvent, { readonly type: "exit" }>,
    SubagentProcessError
  >;
  readonly send: (command: RpcCommand) => Effect.Effect<void, SubagentProcessError>;
  readonly sendContactControl: (
    control: LocalPiParentControl,
  ) => Effect.Effect<void, SubagentProcessError>;
  readonly terminate: (mode: "graceful" | "force") => Effect.Effect<void, SubagentProcessError>;
}

export interface ChildProcessContract {
  readonly spawn: (
    request: ChildLaunchRequest,
  ) => Effect.Effect<ChildProcessHandle, SubagentProcessError, Scope.Scope>;
  readonly reclaimRunState: (request: {
    readonly parentSessionId: string;
    readonly runId: string;
  }) => Effect.Effect<void, SubagentProcessError>;
}

export function safeSubagentDirectorySegment(value: string): string {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
  return `id-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

export const subagentRunDirectory = (
  agentDirectory: string,
  parentSessionId: string,
  runId: string,
): string =>
  join(
    agentDirectory,
    "subagents",
    safeSubagentDirectorySegment(parentSessionId),
    safeSubagentDirectorySegment(runId),
  );

const reclaimChildRunState = (
  agentDirectory: string,
  request: { readonly parentSessionId: string; readonly runId: string },
) =>
  Effect.tryPromise({
    try: () => {
      const runDirectory = subagentRunDirectory(
        agentDirectory,
        request.parentSessionId,
        request.runId,
      );
      return rm(runDirectory, { recursive: true, force: true }).then(() =>
        rmdir(join(runDirectory, "..")).catch((error) => {
          // SAFETY: The boundary adapter's ownership and validation checks establish this host contract before use.
          const code =
            hasObjectRuntimeType(error) && error !== null && "code" in error
              ? (error as { readonly code?: unknown }).code
              : undefined;
          if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "EBUSY")
            throw error;
        }),
      );
    },
    catch: (error) => processError("reclaim subagent run state", error),
  });

export interface ChildToolPolicy {
  readonly enabled: ReadonlyArray<string>;
  readonly excluded: string;
}

export const childToolPolicy = (rootActiveTools: ReadonlyArray<string>): ChildToolPolicy => ({
  enabled: [...new Set([...rootActiveTools, "contact_parent", ...SUBAGENT_TOOL_NAMES])],
  excluded: PI_CHILD_COMPETING_ORCHESTRATOR_TOOL_ARGUMENT,
});

export const requestCooperativeAbort = (
  send: (command: RpcCommand) => Effect.Effect<void, SubagentProcessError>,
): Effect.Effect<void> =>
  send({ type: "abort" }).pipe(
    Effect.interruptible,
    Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.void }),
    Effect.catch(() => Effect.void),
  );

function sanitizedEnvironment(request: ChildLaunchRequest): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => value !== undefined && !BLOCKED_ENV_KEYS.has(key),
      ),
    ),
    PI_SUBAGENT_CHILD: "1",
    PI_SUBAGENT_PARENT_SESSION: request.parentSessionId,
    PI_SUBAGENT_RUN_ID: request.runId,
    ...(request.runtimeApiKey && {
      [RUNTIME_API_KEY_ENV]: Redacted.value(request.runtimeApiKey),
      [RUNTIME_API_PROVIDER_ENV]: request.model.slice(0, request.model.indexOf("/")),
    }),
  };
}

// Children do not load Better OpenAI's checkpoint decoder. Restore its plaintext branch
// instead of inheriting an opaque checkpoint with only one retained conversation entry.
const isEncryptedWorkspaceCheckpoint = Schema.is(
  Schema.Struct({ type: Schema.Literal("pi-better-openai.compaction.v1") }),
);

const cloneEntry = (entry: SessionEntry, parentId: string | null): SessionEntry => {
  if (
    entry.type === "label" ||
    (entry.type === "message" && entry.message.role === "system") ||
    (entry.type === "compaction" && isEncryptedWorkspaceCheckpoint(entry.details))
  ) {
    // Keep tree/compaction anchors, but never inherit parent prompt or tool authority.
    return {
      type: "custom",
      customType: "pi-subagents-fork-anchor",
      id: entry.id,
      parentId,
      timestamp: entry.timestamp,
    };
  }
  if (entry.type === "compaction") {
    const cloned = { ...entry, parentId };
    delete cloned.systemMessage;
    return cloned;
  }
  if (entry.type === "message" && entry.message.role === "assistant") {
    return {
      ...entry,
      parentId,
      message: {
        ...entry.message,
        // Signed/redacted provider thinking blocks are not portable across child models.
        content: entry.message.content.filter((part) => part.type !== "thinking"),
      },
    };
  }
  return { ...entry, parentId };
};

export const createForkedSession = Effect.fn("ChildProcess.createForkedSession")(
  function* (request: ChildLaunchRequest, runDir: string) {
    if (!request.parentSessionFile || !request.parentLeafId)
      return yield* Effect.fail(
        processError(
          "fork parent session",
          "Forked context requires a persisted parent session and stable parent leaf.",
        ),
      );
    const parentSessionFile = request.parentSessionFile;
    const content = yield* Effect.tryPromise({
      try: () => readFile(parentSessionFile, "utf8"),
      catch: (error) => processError("read parent session", error),
    });
    const parsedEntries = yield* Effect.try({
      try: () => parseSessionEntries(content),
      catch: (error) => processError("parse parent session", error),
    });
    if (
      !Schema.is(Schema.Struct({ type: Schema.Literal("session"), id: Schema.String }))(
        parsedEntries[0],
      )
    )
      return yield* Effect.fail(
        processError("fork parent session", "The parent session has no valid session header."),
      );
    // Native loading migrates entries, but persistence must stay disabled: open() can repair the parent.
    const branch = yield* Effect.try({
      try: () =>
        SessionManager.inMemory(request.cwd, undefined, parsedEntries).getBranch(
          request.parentLeafId,
        ),
      catch: (error) => processError("load parent branch", error),
    });
    if (branch.length === 0)
      return yield* Effect.fail(
        processError("fork parent session", "The selected parent session branch is empty."),
      );
    const sessionId = randomUUID();
    const sessionFile = join(runDir, `session-${sessionId}.jsonl`);
    const header = {
      type: "session" as const,
      version: 3,
      id: sessionId,
      timestamp: DateTime.formatIso(DateTime.makeUnsafe(synchronousNow())),
      cwd: request.cwd,
      parentSession: request.parentSessionFile,
    };
    let parentId: string | null = null;
    const entries = branch.map((entry) => {
      const cloned = cloneEntry(entry, parentId);
      parentId = cloned.id;
      return cloned;
    });
    const lines = yield* Effect.forEach([header, ...entries], (entry) =>
      Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(entry),
    );
    yield* Effect.tryPromise({
      try: () => writeFile(sessionFile, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 }),
      catch: (error) => processError("write forked session", error),
    });
    return sessionFile;
  },
  Effect.mapError((error) => processError("fork parent session", error)),
);

function extensionPath(): string {
  return fileURLToPath(new URL("./host-child.ts", import.meta.url));
}

// Locally constructed RPC command frames are serialized by this pure protocol encoder.
const encodeRpcCommandFrame = (command: RpcCommand): string => `${JSON.stringify(command)}\n`;

const acquireChild = Effect.fn("ChildProcess.acquire")(function* (
  agentDirectory: string,
  request: ChildLaunchRequest,
  runtime?: ProcessTransportRuntime,
) {
  const runDir = subagentRunDirectory(agentDirectory, request.parentSessionId, request.runId);
  yield* Effect.tryPromise({
    try: () => mkdir(runDir, { recursive: true, mode: 0o700 }),
    catch: (error) => processError("create subagent run directory", error),
  });
  const promptPath = join(runDir, "system-prompt.md");
  yield* Effect.tryPromise({
    try: () => writeFile(promptPath, request.systemPrompt, { encoding: "utf8", mode: 0o600 }),
    catch: (error) => processError("write subagent system prompt", error),
  });
  const sessionFile =
    request.resumeSessionFile === undefined && request.context === "fork"
      ? yield* createForkedSession(request, runDir)
      : undefined;

  // Pi's published CLI bundles dependencies absent from the unbundled dist/cli.js.
  const cliEntry = join(getPackageDir(), "dist", "bundle", "cli.js");
  const toolPolicy = childToolPolicy(request.activeTools);
  const cliArgs = [
    "--mode",
    "rpc",
    "--model",
    request.model,
    "--thinking",
    request.effort,
    ...(request.openaiFastMode ? ["--pi-subagents-fast-mode"] : []),
    "--tools",
    toolPolicy.enabled.join(","),
    "--exclude-tools",
    toolPolicy.excluded,
    "--append-system-prompt",
    promptPath,
    "--name",
    request.name,
    request.projectTrusted ? "--approve" : "--no-approve",
    "--extension",
    extensionPath(),
    ...(request.resumeSessionFile
      ? ["--session", request.resumeSessionFile]
      : sessionFile
        ? ["--session", sessionFile]
        : ["--session-dir", runDir]),
  ];
  const args = [cliEntry, ...cliArgs];
  const { attachment: ipc, ...transport } = yield* acquireProcessTransport(
    {
      spawn: (spawn) =>
        spawn(process.execPath, args, {
          cwd: request.cwd,
          detached: process.platform !== "win32",
          env: sanitizedEnvironment(request),
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          windowsHide: true,
        }),
      platform: process.platform,
      label: "Subagent RPC",
      error: processError,
      message: (value): ChildWireEvent => ({ type: "rpc_message", value }),
      encode: encodeRpcCommandFrame,
      // Pi reports parser overflow to its backend; unlike native CLIs it does not kill here.
      terminateOnParserOverflow: false,
      synchronousWriteFailure: "not_sent",
      requestAbort: requestCooperativeAbort,
      attach: (child, offer) => {
        const ipc = attachLocalPiParentIpc(child, {
          onContact: (contact) => offer({ type: "parent_contact", value: contact }),
          onProtocolError: (message) => offer({ type: "protocol_error", message }),
          onDisconnect: () => {},
        });
        return { value: ipc, detach: ipc.detach };
      },
    },
    runtime,
  );
  return { ...transport, sendContactControl: ipc.sendControl };
});

export class ChildProcess extends Context.Service<ChildProcess, ChildProcessContract>()(
  "pi-subagents/boundary/child-process/ChildProcess",
) {
  static readonly layer = (
    options: {
      readonly agentDirectory?: string;
      readonly transportRuntime?: ProcessTransportRuntime;
    } = {},
  ) => {
    const agentDirectory = options.agentDirectory ?? getAgentDir();
    return Layer.succeed(this, {
      spawn: (request) =>
        Effect.acquireRelease(
          acquireChild(agentDirectory, request, options.transportRuntime),
          (handle) => handle.release.pipe(Effect.orDie),
        ).pipe(Effect.map(({ release: _release, ...handle }) => handle)),
      reclaimRunState: (request) => reclaimChildRunState(agentDirectory, request),
    });
  };
}
