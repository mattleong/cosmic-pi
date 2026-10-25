import { nodeFsPromises, nodePath } from "pi-cosmic-core/platform/node-builtins";
import { removePrivateTree } from "pi-cosmic-core/platform/private-file";
import { sha256Text } from "pi-cosmic-core/security/sha256";
import { synchronousRandomHex, synchronousRandomUuid } from "pi-cosmic-core/platform/native-crypto";
import { fileURLToPath } from "node:url";
import { isGitLocalEnvironmentKey } from "./git-local-environment.ts";
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
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import {
  AGENT_TOOL_NAMES,
  CONTACT_PARENT_TOOL_NAME,
  isWithheldPiChildTool,
  NESTED_SUBAGENT_TOOL_NAMES,
  PI_CHILD_EXCLUDED_TOOL_ARGUMENT,
  PI_FILE_MUTATION_TOOL_NAMES,
} from "../run/tool-policy.ts";
import type { SubagentWriteIntent } from "../domain/routing.ts";
import { processCauseError as processError, type SubagentProcessError } from "../run/errors.ts";
import type { BackendLaunchRequest } from "../backend/model.ts";
import {
  acquireProcessTransport,
  type ProcessTransportHandle,
  type ProcessTransportRuntime,
  type ProcessWireEvent,
} from "./process-transport.ts";
import { nodeErrorCode } from "./harness-shared.ts";
import { recordPrivateStateOwner, SUBAGENT_STATE_ROOT } from "./private-state.ts";
import { attachLocalPiParentIpc } from "./local-pi-ipc.ts";
import {
  type LocalPiContact,
  type LocalPiParentControl,
  type RpcCommand,
} from "../backend/local-pi-protocol.ts";

const fs = nodeFsPromises;

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
  return `id-${Fn.pipe(sha256Text(value), Str.slice(0, 32))}`;
}

type RunDirectory = (request: {
  readonly parentSessionId: string;
  readonly runId: string;
}) => string;

/**
 * Run ids are random, not guaranteed unique, so each runtime adds its own suffix: a resumed session
 * never reuses, or races the sweep of, a directory that an earlier process left behind.
 */
const subagentRunDirectories =
  (agentDirectory: string, runtimeSuffix: string): RunDirectory =>
  ({ parentSessionId, runId }) =>
    nodePath.join(
      agentDirectory,
      SUBAGENT_STATE_ROOT,
      safeSubagentDirectorySegment(parentSessionId),
      `${safeSubagentDirectorySegment(runId)}-${runtimeSuffix}`,
    );

const fileStep = <A>(operation: string, evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (error) => processError(operation, error) });

const reclaimChildRunState = (runDirectory: string) =>
  removePrivateTree(runDirectory).pipe(
    Effect.mapError(() => processError("reclaim subagent run state")),
    Effect.andThen(
      fileStep("reclaim subagent run state", () =>
        fs.rmdir(nodePath.join(runDirectory, "..")).catch((cause: unknown) => {
          const code = nodeErrorCode(cause);
          if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "EBUSY")
            throw cause;
        }),
      ),
    ),
  );

/**
 * A Pi child's `--tools` and `--exclude-tools` arguments. Every spawn, resumes included, applies
 * its write intent here, and a read-only child also excludes the file-mutation tools, so Pi never
 * registers them for it, whatever its snapshot names or an extension activates.
 */
export const childToolPolicy = (
  activeTools: ReadonlyArray<string>,
  writeIntent: SubagentWriteIntent,
) => ({
  enabled: [
    ...new Set([
      ...Arr.filter(activeTools, (name) => !isWithheldPiChildTool(name, writeIntent)),
      CONTACT_PARENT_TOOL_NAME,
      ...NESTED_SUBAGENT_TOOL_NAMES,
      ...AGENT_TOOL_NAMES,
    ]),
  ],
  excluded:
    writeIntent === "writer"
      ? PI_CHILD_EXCLUDED_TOOL_ARGUMENT
      : Arr.join([PI_CHILD_EXCLUDED_TOOL_ARGUMENT, ...PI_FILE_MUTATION_TOOL_NAMES], ","),
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
    ...Rec.fromEntries(
      Arr.filter(
        Rec.toEntries(source),
        ([key, value]) =>
          value !== undefined && !BLOCKED_ENV_KEYS.has(key) && !isGitLocalEnvironmentKey(key),
      ),
    ),
    PI_SUBAGENT_CHILD: "1",
    PI_SUBAGENT_PARENT_SESSION: request.parentSessionId,
    PI_SUBAGENT_RUN_ID: request.runId,
    ...(request.runtimeApiKey && {
      [RUNTIME_API_KEY_ENV]: Redacted.value(request.runtimeApiKey),
      [RUNTIME_API_PROVIDER_ENV]: Fn.pipe(
        request.model,
        Str.slice(
          0,
          Fn.pipe(
            request.model,
            Str.indexOf("/"),
            Option.getOrElse(() => -1),
          ),
        ),
      ),
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

const forkAnchor = (entry: SessionEntry, parentId: string | null): SessionEntry => ({
  type: "custom",
  customType: "pi-subagents-fork-anchor",
  id: entry.id,
  parentId,
  timestamp: entry.timestamp,
});

// The parent's prompt state never reaches the child: its system messages and encrypted checkpoints
// become inert anchors, and Pi rebuilds the plaintext branch behind them.
const cloneEntry = (entry: SessionEntry, parentId: string | null): SessionEntry => {
  if (
    entry.type === "label" ||
    (entry.type === "message" && entry.message.role === "system") ||
    (entry.type === "compaction" && isEncryptedWorkspaceCheckpoint(entry.details))
  )
    return forkAnchor(entry, parentId);
  if (entry.type === "compaction") {
    const cloned = { ...entry, parentId };
    delete cloned.systemMessage;
    return cloned;
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
      fs.readFile(parentSessionFile, "utf8"),
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
    const entries = Arr.map(branch, (entry) => {
      const cloned = cloneEntry(entry, parentId);
      parentId = cloned.id;
      return cloned;
    });
    const lines = yield* Effect.forEach([header, ...entries], (entry) => encodeJsonLine(entry));
    yield* fileStep("write forked session", () =>
      fs.writeFile(sessionFile, Arr.join(lines, "\n") + "\n", { encoding: "utf8", mode: 0o600 }),
    );
    return sessionFile;
  },
  Effect.mapError((error) => processError("fork parent session", error)),
);

/**
 * The mkdir stays interruptible, so a stalled filesystem can't hold cancellation. Once its spawn is
 * interrupted, the run record's reclaim may finish before the mkdir settles, so the late settlement
 * removes the run directory this call created. Concurrent spawns share the session directory and a
 * recursive mkdir can't prove which of them created it, so the startup sweep removes it once empty.
 */
const createRunDirectory = (runDir: string) =>
  Effect.tryPromise({
    try: (signal) =>
      fs
        .mkdir(runDir, { recursive: true, mode: 0o700 })
        .then((created) =>
          signal.aborted && created !== undefined
            ? fs.rmdir(runDir).catch(Fn.constVoid)
            : undefined,
        ),
    catch: (error) => processError("create subagent run directory", error),
  });

const extensionPath = fileURLToPath(new URL("./host-child.ts", import.meta.url));

const acquireChild = Effect.fn("ChildProcess.acquire")(function* (
  runDir: string,
  request: ChildLaunchRequest,
  runtime?: ProcessTransportRuntime,
) {
  yield* createRunDirectory(runDir);
  yield* recordPrivateStateOwner(runDir).pipe(
    Effect.mapError(() => processError("create subagent run directory")),
  );
  const promptPath = nodePath.join(runDir, "system-prompt.md");
  yield* fileStep("write subagent system prompt", () =>
    fs.writeFile(promptPath, request.systemPrompt, { encoding: "utf8", mode: 0o600 }),
  );
  const sessionFile =
    request.resumeSessionFile === undefined && request.context === "fork"
      ? yield* createForkedSession(request, runDir)
      : undefined;

  const cliEntry = nodePath.join(getPackageDir(), "dist", "bundle", "cli.js");
  const toolPolicy = childToolPolicy(request.activeTools, request.writeIntent);
  const cliArgs = [
    "--mode",
    "rpc",
    "--model",
    request.model,
    "--thinking",
    request.effort,
    ...(request.openaiFastMode ? ["--pi-subagents-fast-mode"] : []),
    "--tools",
    Arr.join(toolPolicy.enabled, ","),
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
      confirmDetachedDescendants: request.writeIntent === "writer",
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
    return Layer.sync(this, () => {
      const runDirectory = subagentRunDirectories(agentDirectory, synchronousRandomHex(6));
      return {
        // Left interruptible: the run record's reclaim owns the run directory whatever the spawn
        // outcome, and the transport masks only its own spawn-to-finalizer handoff.
        spawn: (request) => acquireChild(runDirectory(request), request, options.transportRuntime),
        reclaimRunState: (request) => reclaimChildRunState(runDirectory(request)),
      };
    });
  };
}
