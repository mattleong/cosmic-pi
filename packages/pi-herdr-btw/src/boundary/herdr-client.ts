// Fixed Node process and Herdr protocol boundary for the /herdr-btw command.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { runBoundedProcessNode } from "pi-cosmic-core";
import { HerdrBtwError, type HerdrBtwErrorOutcome } from "../btw/errors.ts";

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
export const PaneEnvelopeSchema = Schema.Struct({
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
export const SnapshotEnvelopeSchema = Schema.Struct({
  result: Schema.Struct({
    snapshot: Schema.Struct({
      protocol: Schema.Number.check(Schema.isInt()),
      agents: Schema.Array(PaneSchema).check(Schema.isMaxLength(4_096)),
    }),
  }),
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
  readonly mutation?: boolean | undefined;
  readonly timeoutMillis?: number | undefined;
  readonly confirmedRejectionCodes?: ReadonlyArray<string> | undefined;
}

interface HerdrCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export type HerdrCommandRunner = (
  request: HerdrCommandRequest,
) => Effect.Effect<HerdrCommandOutput, HerdrBtwError>;

export type HerdrProcessRunner = typeof runBoundedProcessNode;

interface HerdrCommandRunnerOptions {
  /** Test seam only. Production always runs the fixed `herdr` executable. */
  readonly executable?: string | undefined;
  /** Test seam for deterministic process lifecycle and transport outcomes. */
  readonly processRunner?: HerdrProcessRunner | undefined;
  /** Test seam only. Production retains the fixed four-MiB bound per output stream. */
  readonly maximumOutputBytes?: number | undefined;
}

const PROCESS_CLEANUP_MILLIS = 1_000;
const MAX_COMMAND_TIMEOUT_MILLIS = 120_000;

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

const herdrCommandExitFailure = (
  request: HerdrCommandRequest,
  mutation: boolean,
  diagnosticSource: string,
): HerdrBtwError => {
  const detail = safeDiagnostic(diagnosticSource);
  const cliError = parseHerdrCliError(diagnosticSource);
  const confirmedRejection =
    mutation &&
    cliError !== undefined &&
    request.confirmedRejectionCodes?.includes(cliError.error.code) === true;
  const outcome: HerdrBtwErrorOutcome = mutation && !confirmedRejection ? "uncertain" : "confirmed";
  const suffix = confirmedRejection ? "rejected" : mutation ? "outcome_uncertain" : "failed";
  return new HerdrBtwError({
    operation: request.operation,
    code: operationCode(request.operation, suffix),
    message: confirmedRejection
      ? `Herdr ${request.operation} was rejected before it was applied.${detail ? ` ${detail}` : ""}`
      : mutation
        ? `Herdr ${request.operation} may have been applied, but its outcome is unconfirmed.${detail ? ` ${detail}` : ""}`
        : `Herdr ${request.operation} failed.${detail ? ` ${detail}` : ""}`,
    outcome,
    herdrCode: cliError?.error.code,
  });
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

const herdrTransportFailure = (request: HerdrCommandRequest, mutation: boolean): HerdrBtwError => {
  const outcome: HerdrBtwErrorOutcome = mutation ? "uncertain" : "confirmed";
  return new HerdrBtwError({
    operation: request.operation,
    code: operationCode(request.operation, mutation ? "outcome_uncertain" : "failed"),
    message: mutation
      ? `Herdr ${request.operation} may have been applied, but its outcome is unconfirmed.`
      : `Unable to run Herdr ${request.operation}.`,
    outcome,
  });
};

export const makeHerdrCommandRunner = (
  sourceEnvironment: Readonly<NodeJS.ProcessEnv>,
  options: HerdrCommandRunnerOptions = {},
): HerdrCommandRunner => {
  const environment = selectHerdrEnvironment(sourceEnvironment);
  const processRunner = options.processRunner ?? runBoundedProcessNode;
  const executable = options.executable ?? HERDR_EXECUTABLE;
  const configuredMaximum = options.maximumOutputBytes ?? MAX_OUTPUT_BYTES;
  const maximumOutputBytes =
    Number.isFinite(configuredMaximum) && configuredMaximum > 0
      ? Math.min(Math.floor(configuredMaximum), MAX_OUTPUT_BYTES)
      : MAX_OUTPUT_BYTES;

  return (request) => {
    const mutation = request.mutation ?? false;
    const configuredTimeout = request.timeoutMillis ?? COMMAND_TIMEOUT_MILLIS;
    const timeoutMillis =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? Math.min(Math.floor(configuredTimeout), MAX_COMMAND_TIMEOUT_MILLIS)
        : COMMAND_TIMEOUT_MILLIS;

    return processRunner({
      executable,
      args: [...request.args],
      environment,
      stdoutLimitBytes: maximumOutputBytes,
      stderrLimitBytes: maximumOutputBytes,
      timeoutMillis,
      cleanupTimeoutMillis: PROCESS_CLEANUP_MILLIS,
      detached: false,
      windowsHide: true,
    }).pipe(
      Effect.mapError(() => herdrTransportFailure(request, mutation)),
      Effect.flatMap((output) => {
        if (
          output.overflowed ||
          output.timedOut ||
          output.cleanupUnconfirmed ||
          Buffer.byteLength(output.stdout, "utf8") > maximumOutputBytes ||
          Buffer.byteLength(output.stderr, "utf8") > maximumOutputBytes
        )
          return Effect.fail(herdrTransportFailure(request, mutation));
        if (output.code !== 0) {
          const killedBySignal = output.code === null && output.signal !== null;
          const detail = killedBySignal
            ? `terminated by ${output.signal} signal${output.stderr ? `: ${output.stderr.trim()}` : ""}`
            : output.stderr || output.stdout;
          return Effect.fail(herdrCommandExitFailure(request, mutation, detail));
        }
        return Effect.succeed({ stdout: output.stdout, stderr: output.stderr });
      }),
    );
  };
};

const decodeJson = <A>(
  schema: Schema.Decoder<A>,
  source: string,
  operation: string,
  mutation: boolean,
): Effect.Effect<A, HerdrBtwError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(source).pipe(
    Effect.mapError(
      () =>
        new HerdrBtwError({
          operation,
          code: operationCode(operation, mutation ? "outcome_uncertain" : "json_invalid"),
          message: mutation
            ? `Herdr ${operation} returned invalid data after the request was dispatched; its outcome is unconfirmed.`
            : `Herdr returned invalid data while attempting to ${operation}.`,
          outcome: mutation ? "uncertain" : "confirmed",
        }),
    ),
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.mapError(
          () =>
            new HerdrBtwError({
              operation,
              code: operationCode(operation, mutation ? "outcome_uncertain" : "protocol_invalid"),
              message: mutation
                ? `Herdr ${operation} returned unexpected data after the request was dispatched; its outcome is unconfirmed.`
                : `Herdr returned unexpected data while attempting to ${operation}.`,
              outcome: mutation ? "uncertain" : "confirmed",
            }),
        ),
      ),
    ),
  );

/**
 * The one decoded protocol door: runs a fixed-argv Herdr command and decodes its
 * JSON envelope. Raw text or discarded responses call the command runner directly.
 */
export const herdrCommand = <A>(
  runner: HerdrCommandRunner,
  request: HerdrCommandRequest & { readonly schema: Schema.Decoder<A> },
): Effect.Effect<A, HerdrBtwError> => {
  const { schema, ...commandRequest } = request;
  return runner(commandRequest).pipe(
    Effect.flatMap((output) =>
      decodeJson(schema, output.stdout, request.operation, request.mutation ?? false),
    ),
  );
};
