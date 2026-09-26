// Codex hook trust: one sequential app-server dialog over the shared local CLI transport.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import {
  decodeCodexEnvelope,
  initializedNotification,
  initializeRequest,
  type CodexHookRequest,
  type CodexInitializeRequest,
} from "../backend/local-codex-protocol.ts";
import { pickEnvironment } from "./harness-shared.ts";
import { acquireLocalCliTransport } from "./local-cli-transport.ts";
import { nodeFsPromises as fs } from "./node-builtins.ts";

const CODEX_EXECUTABLE = "codex";
const CALL_TIMEOUT_MILLIS = 10_000;
const MAX_LINE_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SAFE_ENVIRONMENT_KEYS =
  "HOME USER LOGNAME PATH SHELL TMPDIR TMP TEMP LANG LC_ALL LC_CTYPE SSL_CERT_FILE SSL_CERT_DIR XDG_CONFIG_HOME XDG_STATE_HOME".split(
    " ",
  );

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

type HookEntry = Schema.Schema.Type<typeof HookEntrySchema>;
type HookTransport = Effect.Success<ReturnType<typeof acquireLocalCliTransport>>;

export class HerdrCodexHooksError extends Schema.TaggedError<HerdrCodexHooksError>()(
  "HerdrCodexHooksError",
  {
    code: Schema.Literals([
      "codex_herdr_hook_unavailable",
      "codex_herdr_hook_cleanup_unconfirmed",
    ] as const),
  },
) {}

export interface TrustInput {
  readonly codexHome: string;
  readonly configPath: string;
  readonly hooksPath: string;
  readonly cwd: string;
  readonly command: string;
}

export interface HerdrCodexHooksContract {
  readonly establishTrust: (input: TrustInput) => Effect.Effect<void, HerdrCodexHooksError>;
}

export interface HerdrCodexHooksOptions {
  readonly executable?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMillis?: number | undefined;
}

const decodeHooksListResultOption = Schema.decodeUnknownOption(HooksListResultSchema);
const decodeConfigWriteResultOption = Schema.decodeUnknownOption(ConfigWriteResultSchema);

const makeUnavailable = () => new HerdrCodexHooksError({ code: "codex_herdr_hook_unavailable" });

const makeCleanupUnconfirmed = () =>
  new HerdrCodexHooksError({ code: "codex_herdr_hook_cleanup_unconfirmed" });

/** Maps every typed failure to unavailable, keeping defects, interruption, and every reason. */
const unavailable = <Value, Failure, Requirements>(
  effect: Effect.Effect<Value, Failure, Requirements>,
): Effect.Effect<Value, HerdrCodexHooksError, Requirements> =>
  effect.pipe(Effect.catchCause((cause) => Effect.failCause(Cause.map(cause, makeUnavailable))));
const cleanupCause = <Failure>(cause: Cause.Cause<Failure>): Cause.Cause<HerdrCodexHooksError> =>
  Cause.fromReasons([
    ...Cause.fail(makeCleanupUnconfirmed()).reasons,
    ...Cause.map(cause, makeUnavailable).reasons,
  ]);

const canonicalPath = (path: string): Effect.Effect<string, HerdrCodexHooksError> =>
  Effect.tryPromise({
    try: () => fs.realpath(path),
    catch: () => makeUnavailable(),
  });

const selectOwnedHook = <ValueInput>(
  value: ValueInput,
  input: Pick<TrustInput, "cwd" | "hooksPath" | "command">,
): Effect.Effect<HookEntry, HerdrCodexHooksError> =>
  Effect.gen(function* () {
    const decoded = decodeHooksListResultOption(value);
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

/**
 * One sequential dialog: each call sends a request, then takes events until its response.
 * Notifications are skipped; any other frame, an error response, the session output budget,
 * or the transport ending fails closed.
 */
const runTrustSteps = (
  transport: HookTransport,
  input: TrustInput,
  timeoutMillis: number,
): Effect.Effect<void, HerdrCodexHooksError> => {
  let outputBytes = 0;
  const awaitResponse = (id: string) =>
    Effect.gen(function* () {
      for (;;) {
        const event = yield* Queue.take(transport.events);
        transport.acknowledge(event);
        if (event.type !== "message") return yield* makeUnavailable();
        outputBytes += event.bytes ?? 0;
        if (outputBytes > MAX_OUTPUT_BYTES) return yield* makeUnavailable();
        const envelope = yield* decodeCodexEnvelope(event.value);
        if (envelope.type === "notification") continue;
        if (envelope.type !== "response" || envelope.id !== id || envelope.error)
          return yield* makeUnavailable();
        return envelope.result;
      }
    });
  const call = (frame: CodexInitializeRequest | CodexHookRequest) =>
    unavailable(
      transport.send(frame).pipe(
        Effect.andThen(awaitResponse(frame.id)),
        Effect.timeoutOrElse({
          duration: timeoutMillis,
          orElse: () => Effect.fail(makeUnavailable()),
        }),
      ),
    );
  const listHooks = (id: string) =>
    call({ id, method: "hooks/list", params: { cwds: [input.cwd] } }).pipe(
      Effect.flatMap((value) => selectOwnedHook(value, input)),
    );
  return Effect.gen(function* () {
    yield* call(initializeRequest("initialize"));
    yield* unavailable(transport.send(initializedNotification()));
    const before = yield* listHooks("hooks-before");
    if (before.trustStatus !== "untrusted") return yield* makeUnavailable();
    const write = decodeConfigWriteResultOption(
      yield* call({
        id: "trust",
        method: "config/batchWrite",
        params: {
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
      }),
    );
    if (
      Option.isNone(write) ||
      write.value.status !== "ok" ||
      write.value.overriddenMetadata !== null ||
      (yield* canonicalPath(write.value.filePath)) !== (yield* canonicalPath(input.configPath))
    ) {
      return yield* makeUnavailable();
    }
    const after = yield* listHooks("hooks-after");
    if (
      after.key !== before.key ||
      after.currentHash !== before.currentHash ||
      after.trustStatus !== "trusted"
    ) {
      return yield* makeUnavailable();
    }
  });
};

export const makeHerdrCodexHooks = (
  options: HerdrCodexHooksOptions = {},
): HerdrCodexHooksContract => {
  const fixedEnvironment = pickEnvironment(
    options.environment ?? process.env,
    SAFE_ENVIRONMENT_KEYS,
  );
  const executable = options.executable ?? CODEX_EXECUTABLE;
  const timeoutMillis = options.timeoutMillis ?? CALL_TIMEOUT_MILLIS;
  return {
    establishTrust: (input) =>
      Effect.scoped(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const transport = yield* unavailable(
              Effect.acquireRelease(
                acquireLocalCliTransport({
                  executable,
                  args: ["app-server", "--stdio", "--strict-config"],
                  env: { ...fixedEnvironment, CODEX_HOME: input.codexHome },
                  cwd: input.cwd,
                  maxLineBytes: MAX_LINE_BYTES,
                  synchronousWriteFailure: "not_sent",
                }),
                (owned) => Effect.ignore(owned.release),
              ),
            );
            // Kill at once, then let the cached release confirm exit and sweep the process group.
            const close = transport.terminate("force").pipe(
              Effect.ignore,
              Effect.andThen(transport.release),
              Effect.catchCause((cause) => Effect.failCause(cleanupCause(cause))),
            );
            return yield* restore(runTrustSteps(transport, input, timeoutMillis)).pipe(
              Effect.catchCause((original) =>
                close.pipe(
                  Effect.catchCause((cleanup) =>
                    Effect.failCause(Cause.fromReasons([...cleanup.reasons, ...original.reasons])),
                  ),
                  Effect.andThen(Effect.failCause(original)),
                ),
              ),
              Effect.andThen(close),
            );
          }),
        ),
      ),
  };
};
