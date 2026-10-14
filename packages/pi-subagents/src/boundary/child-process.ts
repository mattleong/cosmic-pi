import { sha256Text, synchronousRandomUuid } from "pi-cosmic-core";
import { fileURLToPath } from "node:url";
import { isGitLocalEnvironmentKey } from "./git-local-environment.ts";
import { PROTOCOL_FINGERPRINT_ENV, protocolFingerprint } from "./protocol-fingerprint.ts";
import { nodeFsPromises, nodePath } from "./node-builtins.ts";
import {
  getAgentDir,
  getPackageDir,
  parseSessionEntries,
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import {
  NESTED_SUBAGENT_TOOL_NAMES,
  PI_CHILD_COMPETING_ORCHESTRATOR_TOOL_ARGUMENT,
} from "../run/tool-policy.ts";
import { processCauseError as processError, type SubagentProcessError } from "../run/errors.ts";
import type { BackendLaunchRequest } from "../backend/model.ts";
import {
  acquireProcessTransport,
  type ProcessTransportHandle,
  type ProcessTransportRuntime,
  type ProcessWireEvent,
} from "./process-transport.ts";
import { nodeErrorCode } from "./harness-shared.ts";
import { attachLocalPiParentIpc } from "./local-pi-ipc.ts";
import {
  type LocalPiContact,
  type LocalPiParentControl,
  type RpcCommand,
} from "../backend/local-pi-protocol.ts";

const { mkdir, readFile, rm, rmdir, writeFile } = nodeFsPromises;

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

export type ChildLaunchRequest = Omit<BackendLaunchRequest, "resumeToken"> & {
  readonly resumeSessionFile?: string | undefined;
};

type ChildMessage =
  | { readonly type: "rpc_message"; readonly value: Schema.Json }
  | { readonly type: "parent_contact"; readonly value: LocalPiContact };

export type ChildWireEvent = ProcessWireEvent<ChildMessage>;

export interface ChildProcessHandle extends ProcessTransportHandle<ChildMessage, RpcCommand> {
  readonly sendContactControl: (
    control: LocalPiParentControl,
  ) => Effect.Effect<void, SubagentProcessError>;
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
  return `id-${sha256Text(value).slice(0, 32)}`;
}

const subagentRunDirectory = (agentDirectory: string, parentSessionId: string, runId: string) =>
  nodePath.join(
    agentDirectory,
    "subagents",
    safeSubagentDirectorySegment(parentSessionId),
    safeSubagentDirectorySegment(runId),
  );

const fileStep = <A>(operation: string, evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (error) => processError(operation, error) });

const reclaimChildRunState = (
  agentDirectory: string,
  request: { readonly parentSessionId: string; readonly runId: string },
) =>
  fileStep("reclaim subagent run state", () => {
    const runDirectory = subagentRunDirectory(
      agentDirectory,
      request.parentSessionId,
      request.runId,
    );
    return rm(runDirectory, { recursive: true, force: true }).then(() =>
      rmdir(nodePath.join(runDirectory, "..")).catch((cause: unknown) => {
        const code = nodeErrorCode(cause);
        if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "EBUSY")
          throw cause;
      }),
    );
  });

export const childToolPolicy = (rootActiveTools: ReadonlyArray<string>) => ({
  enabled: [...new Set([...rootActiveTools, "contact_parent", ...NESTED_SUBAGENT_TOOL_NAMES])],
  excluded: PI_CHILD_COMPETING_ORCHESTRATOR_TOOL_ARGUMENT,
});

export const requestCooperativeAbort = (
  send: (command: RpcCommand) => Effect.Effect<void, SubagentProcessError>,
): Effect.Effect<void> =>
  send({ type: "abort" }).pipe(Effect.interruptible, Effect.timeout("250 millis"), Effect.ignore);

export function childProcessEnvironment(
  source: NodeJS.ProcessEnv,
  request: ChildLaunchRequest,
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(
        ([key, value]) =>
          value !== undefined && !BLOCKED_ENV_KEYS.has(key) && !isGitLocalEnvironmentKey(key),
      ),
    ),
    PI_SUBAGENT_CHILD: "1",
    [PROTOCOL_FINGERPRINT_ENV]: protocolFingerprint(),
    PI_SUBAGENT_PARENT_SESSION: request.parentSessionId,
    PI_SUBAGENT_RUN_ID: request.runId,
    ...(request.runtimeApiKey && {
      [RUNTIME_API_KEY_ENV]: Redacted.value(request.runtimeApiKey),
      [RUNTIME_API_PROVIDER_ENV]: request.model.slice(0, request.model.indexOf("/")),
    }),
  };
}

const isEncryptedWorkspaceCheckpoint = Schema.is(
  Schema.Struct({ type: Schema.Literal("pi-better-openai.compaction.v1") }),
);
const isSessionHeader = Schema.is(
  Schema.Struct({ type: Schema.Literal("session"), id: Schema.String }),
);
const encodeJsonLine = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const cloneEntry = (entry: SessionEntry, parentId: string | null): SessionEntry => {
  if (
    entry.type === "label" ||
    (entry.type === "message" && entry.message.role === "system") ||
    (entry.type === "compaction" && isEncryptedWorkspaceCheckpoint(entry.details))
  ) {
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
        content: entry.message.content.filter((part) => part.type !== "thinking"),
      },
    };
  }
  return { ...entry, parentId };
};

export const createForkedSession = Effect.fn("ChildProcess.createForkedSession")(
  function* (request: ChildLaunchRequest, runDir: string) {
    if (!request.parentSessionFile || !request.parentLeafId)
      return yield* processError(
        "fork parent session",
        "Forked context requires a persisted parent session and stable parent leaf.",
      );
    const parentSessionFile = request.parentSessionFile;
    const content = yield* fileStep("read parent session", () =>
      readFile(parentSessionFile, "utf8"),
    );
    const parsedEntries = yield* Effect.try({
      try: () => parseSessionEntries(content),
      catch: (error) => processError("parse parent session", error),
    });
    if (!isSessionHeader(parsedEntries[0]))
      return yield* processError(
        "fork parent session",
        "The parent session has no valid session header.",
      );
    const branch = yield* Effect.try({
      try: () =>
        SessionManager.inMemory(request.cwd, undefined, parsedEntries).getBranch(
          request.parentLeafId,
        ),
      catch: (error) => processError("load parent branch", error),
    });
    if (branch.length === 0)
      return yield* processError(
        "fork parent session",
        "The selected parent session branch is empty.",
      );
    const sessionId = synchronousRandomUuid();
    const sessionFile = nodePath.join(runDir, `session-${sessionId}.jsonl`);
    const header = {
      type: "session" as const,
      version: 3,
      id: sessionId,
      timestamp: DateTime.formatIso(yield* DateTime.now),
      cwd: request.cwd,
      parentSession: request.parentSessionFile,
    };
    let parentId: string | null = null;
    const entries = branch.map((entry) => {
      const cloned = cloneEntry(entry, parentId);
      parentId = cloned.id;
      return cloned;
    });
    const lines = yield* Effect.forEach([header, ...entries], (entry) => encodeJsonLine(entry));
    yield* fileStep("write forked session", () =>
      writeFile(sessionFile, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 }),
    );
    return sessionFile;
  },
  Effect.mapError((error) => processError("fork parent session", error)),
);

const extensionPath = fileURLToPath(new URL("./host-child.ts", import.meta.url));

const acquireChild = Effect.fn("ChildProcess.acquire")(function* (
  agentDirectory: string,
  request: ChildLaunchRequest,
  runtime?: ProcessTransportRuntime,
) {
  const runDir = subagentRunDirectory(agentDirectory, request.parentSessionId, request.runId);
  yield* fileStep("create subagent run directory", () =>
    mkdir(runDir, { recursive: true, mode: 0o700 }),
  );
  const promptPath = nodePath.join(runDir, "system-prompt.md");
  yield* fileStep("write subagent system prompt", () =>
    writeFile(promptPath, request.systemPrompt, { encoding: "utf8", mode: 0o600 }),
  );
  const sessionFile =
    request.resumeSessionFile === undefined && request.context === "fork"
      ? yield* createForkedSession(request, runDir)
      : undefined;

  const cliEntry = nodePath.join(getPackageDir(), "dist", "bundle", "cli.js");
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
    extensionPath,
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
          detached: true,
          env: childProcessEnvironment(process.env, request),
          stdio: ["pipe", "pipe", "pipe", "ipc"],
        }),
      label: "Subagent RPC",
      error: processError,
      message: (value): ChildWireEvent => ({ type: "rpc_message", value }),
      terminateOnParserOverflow: false,
      synchronousWriteFailure: "not_sent",
      requestAbort: requestCooperativeAbort,
      attach: (child, offer) =>
        attachLocalPiParentIpc(child, {
          onContact: (contact) =>
            offer(
              { type: "parent_contact", value: contact },
              Buffer.byteLength(JSON.stringify(contact), "utf8"),
            ),
          onProtocolError: (message) => offer({ type: "protocol_error", message }),
        }),
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
        Effect.uninterruptible(acquireChild(agentDirectory, request, options.transportRuntime)),
      reclaimRunState: (request) => reclaimChildRunState(agentDirectory, request),
    });
  };
}
