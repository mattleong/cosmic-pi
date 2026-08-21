// Fixed Node process and Herdr protocol boundary for the /herdr-fork command.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import { spawn } from "node:child_process";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { HerdrForkError, herdrForkError, type HerdrForkErrorOutcome } from "../fork/errors.ts";

const HERDR_EXECUTABLE = "herdr";
const COMMAND_TIMEOUT_MILLIS = 15_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const BoundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const BoundedPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));
const HerdrCliErrorEnvelopeSchema = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
  }),
});
const SessionInfoSchema = Schema.Struct({
  source: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  agent: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  kind: Schema.Literals(["id", "path"] as const),
  value: BoundedPath,
});
const PaneSchema = Schema.Struct({
  pane_id: BoundedId,
  terminal_id: BoundedId,
  workspace_id: BoundedId,
  tab_id: BoundedId,
  agent: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(64)))),
  name: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(128)))),
  agent_session: Schema.optional(Schema.NullOr(SessionInfoSchema)),
});
export const ProtocolSchema = Schema.Struct({
  protocol: Schema.Number.check(Schema.isInt()),
});
const PaneEnvelopeSchema = Schema.Struct({
  result: Schema.Struct({ pane: PaneSchema }),
});
export const LayoutEnvelopeSchema = Schema.Struct({
  result: Schema.Struct({
    layout: Schema.Struct({
      workspace_id: BoundedId,
      tab_id: BoundedId,
      area: Schema.Struct({
        width: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
        height: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
      }),
    }),
  }),
});
export const AgentEnvelopeSchema = Schema.Struct({
  result: Schema.Struct({ agent: PaneSchema }),
});
export const PaneProcessInfoEnvelopeSchema = Schema.Struct({
  result: Schema.Struct({
    process_info: Schema.Struct({
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
        ),
      ),
    }),
  }),
});

export type HerdrPane = typeof PaneSchema.Type;
export type HerdrPaneProcessInfo = typeof PaneProcessInfoEnvelopeSchema.Type.result.process_info;

export interface HerdrCommandRequest {
  readonly args: ReadonlyArray<string>;
  readonly operation: string;
  readonly mutation: boolean;
  readonly timeoutMillis?: number | undefined;
  readonly confirmedRejectionCodes?: ReadonlyArray<string> | undefined;
}

export interface HerdrCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export type HerdrCommandRunner = (
  request: HerdrCommandRequest,
) => Effect.Effect<HerdrCommandOutput, HerdrForkError>;

export interface HerdrProcessRequest {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly maximumOutputBytes: number;
}

export interface HerdrProcessResult {
  readonly status: number | null;
  /** Non-null when the child was terminated by a signal instead of exiting normally. */
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly overflowed: boolean;
}

export class HerdrProcessError extends Schema.TaggedError<HerdrProcessError>()(
  "HerdrProcessError",
  { operation: Schema.String, message: Schema.String },
) {}

export type HerdrProcessRunner = (
  request: HerdrProcessRequest,
) => Effect.Effect<HerdrProcessResult, HerdrProcessError, Scope.Scope>;

export interface HerdrCommandRunnerOptions {
  /** Test seam only. Production always runs the fixed `herdr` executable. */
  readonly executable?: string | undefined;
  /** Test seam for deterministic process lifecycle and transport outcomes. */
  readonly processRunner?: HerdrProcessRunner | undefined;
  /** Test seam only. Production retains the fixed four-MiB bound per output stream. */
  readonly maximumOutputBytes?: number | undefined;
}

interface BoundedChunks {
  readonly chunks: Buffer[];
  length: number;
}

interface OwnedHerdrProcess {
  readonly awaitResult: Effect.Effect<HerdrProcessResult, HerdrProcessError>;
  readonly release: Effect.Effect<void>;
}

const PROCESS_CLEANUP_MILLIS = 1_000;
const MAX_COMMAND_TIMEOUT_MILLIS = 120_000;

const processBoundaryError = (operation: string) =>
  new HerdrProcessError({ operation, message: `Unable to ${operation} Herdr process.` });

const appendBounded = (target: BoundedChunks, chunk: Buffer, maximum: number): boolean => {
  const room = maximum - target.length;
  if (room > 0) {
    const accepted = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
    target.chunks.push(accepted);
    target.length += accepted.byteLength;
  }
  return chunk.byteLength > Math.max(0, room);
};

const acquireNodeHerdrProcess = (request: HerdrProcessRequest) =>
  Effect.gen(function* () {
    const completed = yield* Deferred.make<HerdrProcessResult, HerdrProcessError>();
    const closed = yield* Deferred.make<void>();
    const stdout: BoundedChunks = { chunks: [], length: 0 };
    const stderr: BoundedChunks = { chunks: [], length: 0 };
    let overflowed = false;
    let settled = false;
    let closeSettled = false;
    let cleaned = false;

    const child = yield* Effect.try({
      try: () =>
        spawn(request.executable, [...request.args], {
          env: { ...request.environment },
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        }),
      catch: () => processBoundaryError("spawn"),
    });

    const finish = (effect: Effect.Effect<HerdrProcessResult, HerdrProcessError>): void => {
      if (settled) return;
      settled = true;
      Deferred.doneUnsafe(completed, effect);
    };
    const fail = (operation: string): void => finish(Effect.fail(processBoundaryError(operation)));
    const kill = (signal: NodeJS.Signals): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill(signal);
      } catch {
        // Exit and cleanup can race; bounded settlement below is authoritative.
      }
    };
    const append = (target: BoundedChunks, chunk: Buffer): void => {
      if (appendBounded(target, chunk, request.maximumOutputBytes)) {
        overflowed = true;
        kill("SIGKILL");
      }
    };
    const onStdout = (chunk: Buffer) => append(stdout, chunk);
    const onStderr = (chunk: Buffer) => append(stderr, chunk);
    const onStdoutError = () => fail("read Herdr stdout from");
    const onStderrError = () => fail("read Herdr stderr from");
    const onError = () => fail("run");
    const onClose = (status: number | null) => {
      closeSettled = true;
      Deferred.doneUnsafe(closed, Effect.void);
      finish(
        Effect.succeed({
          status,
          signal: child.signalCode ?? null,
          stdout: Buffer.concat(stdout.chunks).toString("utf8"),
          stderr: Buffer.concat(stderr.chunks).toString("utf8"),
          overflowed,
        }),
      );
    };
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      child.stdout?.off("data", onStdout);
      child.stdout?.off("error", onStdoutError);
      child.stderr?.off("data", onStderr);
      child.stderr?.off("error", onStderrError);
      child.off("error", onError);
      child.off("close", onClose);
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    child.stdout?.on("data", onStdout);
    child.stdout?.on("error", onStdoutError);
    child.stderr?.on("data", onStderr);
    child.stderr?.on("error", onStderrError);
    child.once("error", onError);
    child.once("close", onClose);
    if (!child.stdout || !child.stderr) fail("capture output from");

    const awaitBoundedClosure = Deferred.await(closed).pipe(
      Effect.timeoutOption(Duration.millis(PROCESS_CLEANUP_MILLIS)),
    );
    const release = Effect.gen(function* () {
      if (!closeSettled) kill("SIGTERM");
      const graceful = yield* awaitBoundedClosure;
      if (Option.isNone(graceful)) {
        kill("SIGKILL");
        yield* awaitBoundedClosure;
      }
    }).pipe(Effect.ensuring(Effect.sync(cleanup)));

    return { awaitResult: Deferred.await(completed), release } satisfies OwnedHerdrProcess;
  });

/** Scoped asynchronous Node child-process implementation used by the production command runner. */
export const runNodeHerdrProcess: HerdrProcessRunner = (request) =>
  Effect.acquireRelease(acquireNodeHerdrProcess(request), (owned) => owned.release).pipe(
    Effect.flatMap((owned) => owned.awaitResult),
  );

const safeDiagnostic = (value: string): string =>
  [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return !(
        codePoint <= 8 ||
        codePoint === 11 ||
        codePoint === 12 ||
        (codePoint >= 14 && codePoint <= 31) ||
        (codePoint >= 127 && codePoint <= 159)
      );
    })
    .join("")
    .trim()
    .slice(0, 2_000);

const operationCode = (operation: string, suffix: string): string =>
  `herdr_${operation
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "_")
    .replaceAll(/^_|_$/gu, "")}_${suffix}`;

const parseHerdrCliError = (
  source: string,
): typeof HerdrCliErrorEnvelopeSchema.Type | undefined => {
  try {
    return Option.getOrUndefined(
      Schema.decodeUnknownOption(HerdrCliErrorEnvelopeSchema)(JSON.parse(source)),
    );
  } catch {
    return undefined;
  }
};

export const herdrCommandExitFailure = (
  request: HerdrCommandRequest,
  diagnosticSource: string,
): HerdrForkError => {
  const detail = safeDiagnostic(diagnosticSource);
  const cliError = parseHerdrCliError(diagnosticSource);
  const confirmedRejection =
    request.mutation &&
    cliError !== undefined &&
    request.confirmedRejectionCodes?.includes(cliError.error.code) === true;
  const outcome: HerdrForkErrorOutcome =
    request.mutation && !confirmedRejection ? "uncertain" : "confirmed";
  const suffix = confirmedRejection
    ? "rejected"
    : request.mutation
      ? "outcome_uncertain"
      : "failed";
  return herdrForkError(
    request.operation,
    operationCode(request.operation, suffix),
    confirmedRejection
      ? `Herdr ${request.operation} was rejected before it was applied.${detail ? ` ${detail}` : ""}`
      : request.mutation
        ? `Herdr ${request.operation} may have been applied, but its outcome is unconfirmed.${detail ? ` ${detail}` : ""}`
        : `Herdr ${request.operation} failed.${detail ? ` ${detail}` : ""}`,
    outcome,
    undefined,
    cliError?.error.code,
  );
};

export const selectHerdrEnvironment = (source: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv =>
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
        "HERDR_CONFIG_PATH",
        "HERDR_SOCKET_PATH",
        "HERDR_SESSION",
        "HERDR_ENV",
        "HERDR_WORKSPACE_ID",
        "HERDR_TAB_ID",
        "HERDR_PANE_ID",
      ].flatMap((key) => (source[key] === undefined ? [] : ([[key, source[key]]] as const))),
    ),
  );

const herdrTransportFailure = (request: HerdrCommandRequest): HerdrForkError => {
  const outcome: HerdrForkErrorOutcome = request.mutation ? "uncertain" : "confirmed";
  return herdrForkError(
    request.operation,
    operationCode(request.operation, request.mutation ? "outcome_uncertain" : "failed"),
    request.mutation
      ? `Herdr ${request.operation} may have been applied, but its outcome is unconfirmed.`
      : `Unable to run Herdr ${request.operation}.`,
    outcome,
  );
};

export const makeHerdrCommandRunner = (
  sourceEnvironment: Readonly<NodeJS.ProcessEnv>,
  options: HerdrCommandRunnerOptions = {},
): HerdrCommandRunner => {
  const environment = selectHerdrEnvironment(sourceEnvironment);
  const processRunner = options.processRunner ?? runNodeHerdrProcess;
  const executable = options.executable ?? HERDR_EXECUTABLE;
  const configuredMaximum = options.maximumOutputBytes ?? MAX_OUTPUT_BYTES;
  const maximumOutputBytes =
    Number.isFinite(configuredMaximum) && configuredMaximum > 0
      ? Math.min(Math.floor(configuredMaximum), MAX_OUTPUT_BYTES)
      : MAX_OUTPUT_BYTES;

  return (request) => {
    const configuredTimeout = request.timeoutMillis ?? COMMAND_TIMEOUT_MILLIS;
    const timeoutMillis =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? Math.min(Math.floor(configuredTimeout), MAX_COMMAND_TIMEOUT_MILLIS)
        : COMMAND_TIMEOUT_MILLIS;
    const process = Effect.scoped(
      processRunner({
        executable,
        args: [...request.args],
        environment,
        maximumOutputBytes,
      }).pipe(Effect.timeoutOption(Duration.millis(timeoutMillis))),
    );

    return process.pipe(
      Effect.mapError(() => herdrTransportFailure(request)),
      Effect.flatMap((result) => {
        if (Option.isNone(result)) return Effect.fail(herdrTransportFailure(request));
        const output = result.value;
        if (
          output.overflowed ||
          Buffer.byteLength(output.stdout, "utf8") > maximumOutputBytes ||
          Buffer.byteLength(output.stderr, "utf8") > maximumOutputBytes
        )
          return Effect.fail(herdrTransportFailure(request));
        if (output.status !== 0) {
          const killedBySignal = output.status === null && output.signal !== null;
          const detail = killedBySignal
            ? `terminated by ${output.signal} signal${output.stderr ? `: ${output.stderr.trim()}` : ""}`
            : output.stderr || output.stdout;
          return Effect.fail(herdrCommandExitFailure(request, detail));
        }
        return Effect.succeed({ stdout: output.stdout, stderr: output.stderr });
      }),
    );
  };
};

export const decodeJson = <A>(
  schema: Schema.Decoder<A>,
  source: string,
  operation: string,
  mutation = false,
): Effect.Effect<A, HerdrForkError> =>
  Effect.try({
    try: () => JSON.parse(source),
    catch: () =>
      herdrForkError(
        operation,
        operationCode(operation, mutation ? "outcome_uncertain" : "json_invalid"),
        mutation
          ? `Herdr ${operation} returned invalid data after the request was dispatched; its outcome is unconfirmed.`
          : `Herdr returned invalid data while attempting to ${operation}.`,
        mutation ? "uncertain" : "confirmed",
      ),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.mapError(() =>
          herdrForkError(
            operation,
            operationCode(operation, mutation ? "outcome_uncertain" : "protocol_invalid"),
            mutation
              ? `Herdr ${operation} returned unexpected data after the request was dispatched; its outcome is unconfirmed.`
              : `Herdr returned unexpected data while attempting to ${operation}.`,
            mutation ? "uncertain" : "confirmed",
          ),
        ),
      ),
    ),
  );

export const command = (
  runner: HerdrCommandRunner,
  args: ReadonlyArray<string>,
  operation: string,
  mutation = false,
  timeoutMillis?: number,
  confirmedRejectionCodes?: ReadonlyArray<string>,
): Effect.Effect<HerdrCommandOutput, HerdrForkError> =>
  runner(
    (() => {
      const objectPart9136_0 = { args, operation, mutation };
      const objectPart9136_1 =
        timeoutMillis === undefined ? objectPart9136_0 : { ...objectPart9136_0, timeoutMillis };
      const objectPart9136_2 =
        confirmedRejectionCodes === undefined
          ? objectPart9136_1
          : { ...objectPart9136_1, confirmedRejectionCodes };
      return objectPart9136_2;
    })(),
  );

export const paneCommand = (
  runner: HerdrCommandRunner,
  args: ReadonlyArray<string>,
  operation: string,
  mutation = false,
): Effect.Effect<HerdrPane, HerdrForkError> =>
  command(runner, args, operation, mutation).pipe(
    Effect.flatMap((output) =>
      decodeJson(PaneEnvelopeSchema, output.stdout, operation, mutation).pipe(
        Effect.map(({ result }) => result.pane),
      ),
    ),
  );
