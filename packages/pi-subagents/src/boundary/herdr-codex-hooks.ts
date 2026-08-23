// Codex hook discovery/trust and its bounded app-server process live at this boundary.
import { nodeFsPromises as fs } from "./node-builtins.ts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  makeNdjsonRpcSession,
  type InboundClassification,
  type NdjsonRpcSession,
  type RpcSessionError,
} from "./rpc-session.ts";

const CODEX_EXECUTABLE = "codex";
const CALL_TIMEOUT_MILLIS = 10_000;
const MAX_LINE_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 32 * 1024;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ENVIRONMENT_KEYS = new Set([
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
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
]);

const BoundedText = Schema.String.check(Schema.isMaxLength(4_096));
const BoundedNonEmptyText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));
const HookEntrySchema = Schema.Struct({
  key: BoundedNonEmptyText,
  eventName: Schema.Literal("sessionStart"),
  handlerType: Schema.Literal("command"),
  matcher: Schema.NullOr(BoundedText),
  command: Schema.NullOr(BoundedText),
  sourcePath: BoundedNonEmptyText,
  source: Schema.Literal("user"),
  pluginId: Schema.Null,
  enabled: Schema.Boolean,
  isManaged: Schema.Boolean,
  currentHash: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(HASH_PATTERN),
  ),
  trustStatus: Schema.Literals(["managed", "untrusted", "trusted", "modified"] as const),
});
const HooksListResultSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      cwd: BoundedNonEmptyText,
      hooks: Schema.Array(HookEntrySchema).check(Schema.isMaxLength(64)),
      warnings: Schema.Array(BoundedText).check(Schema.isMaxLength(64)),
      errors: Schema.Array(Schema.Struct({ path: BoundedText, message: BoundedText })).check(
        Schema.isMaxLength(64),
      ),
    }),
  ).check(Schema.isMaxLength(8)),
});
const ConfigWriteResultSchema = Schema.Struct({
  status: Schema.Literals(["ok", "okOverridden"] as const),
  version: BoundedNonEmptyText,
  filePath: BoundedNonEmptyText,
  overriddenMetadata: Schema.NullOr(Schema.MutableJson),
});
const RpcSuccessSchema = Schema.Struct({ id: BoundedNonEmptyText, result: Schema.MutableJson });
const RpcFailureSchema = Schema.Struct({
  id: BoundedNonEmptyText,
  error: Schema.Struct({ code: BoundedText, message: BoundedText }),
});

type HookEntry = Schema.Schema.Type<typeof HookEntrySchema>;
type RpcSuccess = Schema.Schema.Type<typeof RpcSuccessSchema>;
type RpcFailure = Schema.Schema.Type<typeof RpcFailureSchema>;
type RpcResponse = RpcSuccess | RpcFailure;

export class HerdrCodexHooksError extends Schema.TaggedError<HerdrCodexHooksError>()(
  "HerdrCodexHooksError",
  {
    code: Schema.Literals([
      "codex_herdr_hook_unavailable",
      "codex_herdr_hook_cleanup_unconfirmed",
    ] as const),
  },
) {}

export const isHerdrCodexHooksError = <ErrorInput>(
  error: ErrorInput,
): error is ErrorInput & HerdrCodexHooksError => error instanceof HerdrCodexHooksError;

export interface HerdrCodexHooksContract {
  readonly establishTrust: (input: {
    readonly codexHome: string;
    readonly configPath: string;
    readonly hooksPath: string;
    readonly cwd: string;
    readonly command: string;
  }) => Effect.Effect<void, HerdrCodexHooksError>;
}

export interface HerdrCodexHooksOptions {
  /** Test seam only. Production always uses the fixed `codex` executable. */
  readonly executable?: string | undefined;
  /** Captured parent environment. CODEX_HOME is always replaced with private harness state. */
  readonly environment?: NodeJS.ProcessEnv | undefined;
  /** Test seam only. */
  readonly timeoutMillis?: number | undefined;
}

interface TrustInput {
  readonly codexHome: string;
  readonly configPath: string;
  readonly hooksPath: string;
  readonly cwd: string;
  readonly command: string;
}

const decodeInboundOption = Schema.decodeUnknownOption;

const classifyRpcLine = (line: string): InboundClassification<RpcResponse> => {
  const parsed = decodeInboundOption(Schema.fromJsonString(Schema.Unknown))(line);
  if (Option.isNone(parsed))
    return { kind: "protocol-error", reason: "Codex hook session returned malformed JSON." };
  const value = parsed.value;
  const success = decodeInboundOption(RpcSuccessSchema)(value);
  if (Option.isSome(success)) {
    return { kind: "reply", id: success.value.id, value: success.value };
  }
  const failure = decodeInboundOption(RpcFailureSchema)(value);
  if (Option.isSome(failure)) {
    return { kind: "rejection", id: failure.value.id, detail: failure.value.error.message };
  }
  // Notifications and unrelated frames are ignored; only replies correlate to pending calls.
  return { kind: "ignore" };
};

const makeUnavailable = () => new HerdrCodexHooksError({ code: "codex_herdr_hook_unavailable" });

// SAFETY: Trust steps only fail with HerdrCodexHooksError; any other cause degrades to unavailable.
const toHooksFailure = (cause: Cause.Cause<HerdrCodexHooksError>): HerdrCodexHooksError => {
  const failure = Cause.squash(cause);
  return failure instanceof HerdrCodexHooksError ? failure : makeUnavailable();
};

const makeCleanupUnconfirmed = () =>
  new HerdrCodexHooksError({ code: "codex_herdr_hook_cleanup_unconfirmed" });

const toUnavailable = (_error: RpcSessionError): HerdrCodexHooksError => makeUnavailable();

const canonicalPath = (path: string): Effect.Effect<string, HerdrCodexHooksError> =>
  Effect.tryPromise({
    try: () => fs.realpath(path),
    catch: () => makeUnavailable(),
  });

const selectOwnedHook = (
  value: Schema.MutableJson,
  input: {
    readonly cwd: string;
    readonly hooksPath: string;
    readonly command: string;
  },
): Effect.Effect<HookEntry, HerdrCodexHooksError> =>
  Effect.gen(function* () {
    const decoded = decodeInboundOption(HooksListResultSchema)(value);
    if (Option.isNone(decoded) || decoded.value.data.length !== 1) return yield* makeUnavailable();
    const result = decoded.value.data[0]!;
    if (
      result.warnings.length > 0 ||
      result.errors.length > 0 ||
      result.hooks.length !== 1 ||
      (yield* canonicalPath(result.cwd)) !== (yield* canonicalPath(input.cwd))
    ) {
      return yield* makeUnavailable();
    }
    const hook = result.hooks[0]!;
    if (
      (yield* canonicalPath(hook.sourcePath)) !== (yield* canonicalPath(input.hooksPath)) ||
      hook.command !== input.command ||
      hook.matcher !== "startup" ||
      !hook.enabled ||
      hook.isManaged
    ) {
      return yield* makeUnavailable();
    }
    return hook;
  });

// Locally constructed hook JSON-RPC request frames are serialized by this pure dialect encoder.
const requestFrame = (id: string, method: string, params: Schema.MutableJson): string =>
  `${JSON.stringify({ id, method, params })}\n`;

const callJson = (
  session: NdjsonRpcSession<RpcResponse>,
  id: string,
  method: string,
  params: Schema.MutableJson,
  timeoutMillis: number,
): Effect.Effect<Schema.MutableJson, HerdrCodexHooksError> =>
  Effect.gen(function* () {
    const response = yield* session
      .call(id, requestFrame(id, method, params), timeoutMillis)
      .pipe(Effect.mapError(toUnavailable));
    if (!("result" in response) || response.id !== id) return yield* makeUnavailable();
    return response.result;
  });

const notify = (
  session: NdjsonRpcSession<RpcResponse>,
  method: string,
  params: Schema.MutableJson,
): Effect.Effect<void, HerdrCodexHooksError> =>
  session.notify(`${JSON.stringify({ method, params })}\n`).pipe(Effect.mapError(toUnavailable));

const runTrustSteps = (
  session: NdjsonRpcSession<RpcResponse>,
  input: TrustInput,
  timeoutMillis: number,
): Effect.Effect<void, HerdrCodexHooksError> =>
  Effect.gen(function* () {
    yield* callJson(
      session,
      "initialize",
      "initialize",
      {
        clientInfo: { name: "pi-subagents", title: "pi-subagents", version: "1" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      },
      timeoutMillis,
    );
    yield* notify(session, "initialized", {});
    const before = yield* selectOwnedHook(
      yield* callJson(session, "hooks-before", "hooks/list", { cwds: [input.cwd] }, timeoutMillis),
      input,
    );
    if (before.trustStatus !== "untrusted") return yield* makeUnavailable();
    const trustResult = yield* callJson(
      session,
      "trust",
      "config/batchWrite",
      {
        edits: [
          {
            keyPath: "hooks.state",
            value: { [before.key]: { trusted_hash: before.currentHash } },
            mergeStrategy: "upsert",
          },
        ],
        filePath: null,
        expectedVersion: null,
        reloadUserConfig: true,
      },
      timeoutMillis,
    );
    const write = decodeInboundOption(ConfigWriteResultSchema)(trustResult);
    if (
      Option.isNone(write) ||
      write.value.status !== "ok" ||
      write.value.overriddenMetadata !== null ||
      (yield* canonicalPath(write.value.filePath)) !== (yield* canonicalPath(input.configPath))
    ) {
      return yield* makeUnavailable();
    }
    const after = yield* selectOwnedHook(
      yield* callJson(session, "hooks-after", "hooks/list", { cwds: [input.cwd] }, timeoutMillis),
      input,
    );
    if (
      after.key !== before.key ||
      after.currentHash !== before.currentHash ||
      after.trustStatus !== "trusted"
    ) {
      return yield* makeUnavailable();
    }
  });

export const makeHerdrCodexHooks = (
  options: HerdrCodexHooksOptions = {},
): HerdrCodexHooksContract => {
  const fixedEnvironment = Object.freeze(
    Object.fromEntries(
      Object.entries(options.environment ?? process.env).filter(
        ([key, value]) => value !== undefined && SAFE_ENVIRONMENT_KEYS.has(key),
      ),
    ),
  );
  const executable = options.executable ?? CODEX_EXECUTABLE;
  const timeoutMillis = options.timeoutMillis ?? CALL_TIMEOUT_MILLIS;
  return {
    establishTrust: (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const environment = { ...fixedEnvironment, CODEX_HOME: input.codexHome };
          const opened = yield* Effect.exit(
            makeNdjsonRpcSession<RpcResponse>({
              command: executable,
              args: ["app-server", "--stdio", "--strict-config"],
              cwd: input.cwd,
              environment,
              diagnosticMaxBytes: MAX_DIAGNOSTIC_BYTES,
              waitForSpawnEvent: true,
              maxLineBytes: MAX_LINE_BYTES,
              maxQueuedOutputBytes: MAX_OUTPUT_BYTES,
              maxTotalOutputBytes: MAX_OUTPUT_BYTES,
              maxPendingCalls: 64,
              writeQueueCapacity: 32,
              classifyInbound: classifyRpcLine,
              unknownReplyPolicy: "fail-session",
            }),
          );
          if (Exit.isFailure(opened)) return yield* makeUnavailable();
          const session = opened.value;
          const steps = yield* Effect.exit(runTrustSteps(session, input, timeoutMillis));
          const failure = Exit.isFailure(steps) ? toHooksFailure(steps.cause) : undefined;
          // Cleanup confirmation stays observable: an unconfirmed kill must fail closed even
          // when the trust steps themselves succeeded.
          const closed = yield* Effect.exit(session.close());
          if (Exit.isFailure(closed)) return yield* makeCleanupUnconfirmed();
          if (failure) return yield* failure;
        }),
      ),
  };
};
