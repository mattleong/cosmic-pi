// Fixed Node process and Herdr protocol boundary for the /herdr-fork command.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { runBoundedProcessNode } from "pi-cosmic-core";
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

const PROCESS_CLEANUP_MILLIS = 1_000;
const MAX_COMMAND_TIMEOUT_MILLIS = 120_000;

const processBoundaryError = (operation: string) =>
  new HerdrProcessError({ operation, message: `Unable to ${operation} Herdr process.` });

/** Scoped Effect child-process implementation used by the production command runner. */
export const runNodeHerdrProcess: HerdrProcessRunner = (request) =>
  runBoundedProcessNode({
    executable: request.executable,
    args: request.args,
    environment: request.environment,
    stdoutLimitBytes: request.maximumOutputBytes,
    stderrLimitBytes: request.maximumOutputBytes,
    timeoutMillis: MAX_COMMAND_TIMEOUT_MILLIS,
    cleanupTimeoutMillis: PROCESS_CLEANUP_MILLIS,
    detached: false,
    windowsHide: true,
  }).pipe(
    Effect.flatMap((result) =>
      result.timedOut || result.cleanupUnconfirmed
        ? Effect.fail(processBoundaryError("run"))
        : Effect.succeed({
            status: result.code,
            // SAFETY: The Node process adapter extracts only Node-reported signal names.
            signal: result.signal as NodeJS.Signals | null,
            stdout: result.stdout,
            stderr: result.stderr,
            overflowed: result.overflowed,
          }),
    ),
    Effect.mapError((error) =>
      error instanceof HerdrProcessError ? error : processBoundaryError(error.operation),
    ),
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

const parseHerdrCliError = (source: string): typeof HerdrCliErrorEnvelopeSchema.Type | undefined =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(HerdrCliErrorEnvelopeSchema))(source),
  );

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
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(source).pipe(
    Effect.mapError(() =>
      herdrForkError(
        operation,
        operationCode(operation, mutation ? "outcome_uncertain" : "json_invalid"),
        mutation
          ? `Herdr ${operation} returned invalid data after the request was dispatched; its outcome is unconfirmed.`
          : `Herdr returned invalid data while attempting to ${operation}.`,
        mutation ? "uncertain" : "confirmed",
      ),
    ),
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
): Effect.Effect<HerdrCommandOutput, HerdrForkError> => {
  const requestBase = { args, operation, mutation };
  const requestWithTimeout =
    timeoutMillis !== undefined ? { ...requestBase, timeoutMillis } : requestBase;
  return runner(
    confirmedRejectionCodes !== undefined
      ? { ...requestWithTimeout, confirmedRejectionCodes }
      : requestWithTimeout,
  );
};

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
