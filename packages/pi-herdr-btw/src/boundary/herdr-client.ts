// Fixed Node process and Herdr protocol boundary for the /herdr-btw command.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  runBoundedProcessNode,
  sanitizeDiagnosticContent,
  type BoundedProcessError,
} from "pi-cosmic-core";
import { HerdrBtwError, type HerdrBtwErrorOutcome } from "../btw/errors.ts";
import { herdrBtwParentMarkerArguments } from "../btw/marker.ts";

const HERDR_EXECUTABLE = "herdr";
const COMMAND_TIMEOUT_MILLIS = 15_000;
const START_TIMEOUT_MILLIS = 70_000;
const PROCESS_CLEANUP_MILLIS = 1_000;
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
const ProtocolSchema = Schema.Struct({
  protocol: Schema.Number.check(Schema.isInt()),
});
const PaneEnvelopeSchema = Schema.Struct({
  result: Schema.Struct({ pane: PaneSchema }),
});
const LayoutEnvelopeSchema = Schema.Struct({
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
const AgentEnvelopeSchema = Schema.Struct({
  result: Schema.Struct({ agent: PaneSchema }),
});
const SnapshotEnvelopeSchema = Schema.Struct({
  result: Schema.Struct({
    snapshot: Schema.Struct({
      protocol: Schema.Number.check(Schema.isInt()),
      agents: Schema.Array(PaneSchema).check(Schema.isMaxLength(4_096)),
    }),
  }),
});
const PaneProcessInfoEnvelopeSchema = Schema.Struct({
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
export type HerdrPaneLayout = typeof LayoutEnvelopeSchema.Type.result.layout;
export type HerdrPaneProcessInfo = typeof PaneProcessInfoEnvelopeSchema.Type.result.process_info;

export interface HerdrSplitPaneInput {
  readonly parentPaneId: string;
  readonly direction: "right" | "down";
  readonly cwd: string;
}

export interface HerdrStartSideSessionInput {
  readonly agentName: string;
  readonly paneId: string;
  readonly childSessionId: string;
  readonly childSessionPath: string;
  readonly parentSessionId: string;
  readonly parentSessionPath: string;
  readonly displayName?: string | undefined;
}

export type HerdrClientContract = ReturnType<typeof makeHerdrClient>;

export class HerdrClient extends Context.Service<HerdrClient, HerdrClientContract>()(
  "pi-herdr-btw/boundary/herdr-client/HerdrClient",
) {
  static layer(environment: Readonly<NodeJS.ProcessEnv>) {
    return Layer.succeed(this, makeHerdrClient(environment));
  }
}

interface HerdrCommandRequest {
  readonly args: ReadonlyArray<string>;
  readonly operation: string;
  readonly mutation: boolean;
  readonly timeoutMillis?: number | undefined;
  readonly confirmedRejectionCodes?: ReadonlyArray<string> | undefined;
}

interface HerdrCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

type HerdrCommandRunner = (
  request: HerdrCommandRequest,
) => Effect.Effect<HerdrCommandOutput, HerdrBtwError>;

export type HerdrProcessRunner = typeof runBoundedProcessNode;

export interface HerdrClientOptions {
  /** Test seam only. Production always runs the fixed `herdr` executable. */
  readonly executable?: string | undefined;
  /** Test seam for deterministic process lifecycle and transport outcomes. */
  readonly processRunner?: HerdrProcessRunner | undefined;
  /** Test seam only. Production retains the fixed four-MiB bound per output stream. */
  readonly maximumOutputBytes?: number | undefined;
}

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
  diagnosticSource: string,
): HerdrBtwError => {
  const detail = sanitizeDiagnosticContent(diagnosticSource, {
    maximumLength: 2_000,
  }).trim();
  const cliError = parseHerdrCliError(diagnosticSource);
  const confirmedRejection =
    request.mutation &&
    cliError !== undefined &&
    request.confirmedRejectionCodes?.includes(cliError.error.code) === true;
  const outcome: HerdrBtwErrorOutcome =
    request.mutation && !confirmedRejection ? "uncertain" : "confirmed";
  const suffix = confirmedRejection
    ? "rejected"
    : request.mutation
      ? "outcome_uncertain"
      : "failed";
  return new HerdrBtwError({
    operation: request.operation,
    code: operationCode(request.operation, suffix),
    message: confirmedRejection
      ? `Herdr ${request.operation} was rejected before it was applied.${detail ? ` ${detail}` : ""}`
      : request.mutation
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

const herdrTransportFailure = (
  request: HerdrCommandRequest,
  failure?: BoundedProcessError | undefined,
): HerdrBtwError => {
  const failedBeforeDispatch = failure?.operation === "spawn";
  const outcome: HerdrBtwErrorOutcome =
    request.mutation && !failedBeforeDispatch ? "uncertain" : "confirmed";
  return new HerdrBtwError({
    operation: request.operation,
    code: operationCode(
      request.operation,
      request.mutation && !failedBeforeDispatch ? "outcome_uncertain" : "failed",
    ),
    message:
      request.mutation && !failedBeforeDispatch
        ? `Herdr ${request.operation} may have been applied, but its outcome is unconfirmed.`
        : `Unable to run Herdr ${request.operation}.`,
    outcome,
  });
};

const makeHerdrCommandRunner = (
  sourceEnvironment: Readonly<NodeJS.ProcessEnv>,
  options: HerdrClientOptions,
): HerdrCommandRunner => {
  const environment = selectHerdrEnvironment(sourceEnvironment);
  const processRunner = options.processRunner ?? runBoundedProcessNode;
  const executable = options.executable ?? HERDR_EXECUTABLE;
  const configuredMaximum = options.maximumOutputBytes ?? MAX_OUTPUT_BYTES;
  const maximumOutputBytes =
    Number.isFinite(configuredMaximum) && configuredMaximum > 0
      ? Math.min(Math.floor(configuredMaximum), MAX_OUTPUT_BYTES)
      : MAX_OUTPUT_BYTES;

  return (request) =>
    processRunner({
      executable,
      args: [...request.args],
      environment,
      stdoutLimitBytes: maximumOutputBytes,
      stderrLimitBytes: maximumOutputBytes,
      timeoutMillis: request.timeoutMillis ?? COMMAND_TIMEOUT_MILLIS,
      cleanupTimeoutMillis: PROCESS_CLEANUP_MILLIS,
      detached: false,
      windowsHide: true,
    }).pipe(
      Effect.mapError((failure) => herdrTransportFailure(request, failure)),
      Effect.flatMap((output) => {
        if (output.overflowed || output.timedOut || output.cleanupUnconfirmed)
          return Effect.fail(herdrTransportFailure(request));
        if (output.code !== 0) {
          const killedBySignal = output.code === null && output.signal !== null;
          const detail = killedBySignal
            ? `terminated by ${output.signal} signal${output.stderr ? `: ${output.stderr.trim()}` : ""}`
            : output.stderr || output.stdout;
          return Effect.fail(herdrCommandExitFailure(request, detail));
        }
        return Effect.succeed({ stdout: output.stdout, stderr: output.stderr });
      }),
    );
};

const herdrDecodeFailure = (
  request: HerdrCommandRequest,
  kind: "json" | "protocol",
): HerdrBtwError => {
  const description = kind === "json" ? "invalid" : "unexpected";
  return new HerdrBtwError({
    operation: request.operation,
    code: operationCode(
      request.operation,
      request.mutation ? "outcome_uncertain" : `${kind}_invalid`,
    ),
    message: request.mutation
      ? `Herdr ${request.operation} returned ${description} data after the request was dispatched; its outcome is unconfirmed.`
      : `Herdr returned ${description} data while attempting to ${request.operation}.`,
    outcome: request.mutation ? "uncertain" : "confirmed",
  });
};

const decodeJson = <A>(
  schema: Schema.Decoder<A>,
  source: string,
  request: HerdrCommandRequest,
): Effect.Effect<A, HerdrBtwError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(source).pipe(
    Effect.mapError(() => herdrDecodeFailure(request, "json")),
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.mapError(() => herdrDecodeFailure(request, "protocol")),
      ),
    ),
  );

export const makeHerdrClient = (
  sourceEnvironment: Readonly<NodeJS.ProcessEnv>,
  options: HerdrClientOptions = {},
) => {
  const run = makeHerdrCommandRunner(sourceEnvironment, options);
  const decoded = <A>(request: HerdrCommandRequest, schema: Schema.Decoder<A>) =>
    run(request).pipe(Effect.flatMap((output) => decodeJson(schema, output.stdout, request)));

  return {
    inspectProtocol: Effect.fn("HerdrClient.inspectProtocol")(() =>
      decoded(
        {
          args: ["api", "schema", "--json"],
          operation: "inspect protocol",
          mutation: false,
        },
        ProtocolSchema,
      ).pipe(Effect.map((protocol) => protocol.protocol)),
    ),
    inspectPiIntegration: Effect.fn("HerdrClient.inspectPiIntegration")(() =>
      run({
        args: ["integration", "status"],
        operation: "inspect Pi integration",
        mutation: false,
      }).pipe(
        Effect.map((output) => {
          const piIntegration = output.stdout
            .split(/\r?\n/gu)
            .find((line) => line.startsWith("pi:"));
          return (
            piIntegration !== undefined && /^pi: current \(v\d+\) \(.+\)$/u.test(piIntegration)
          );
        }),
      ),
    ),
    resolveCallingPane: Effect.fn("HerdrClient.resolveCallingPane")(() =>
      decoded(
        {
          args: ["pane", "current", "--current"],
          operation: "resolve calling pane",
          mutation: false,
        },
        PaneEnvelopeSchema,
      ).pipe(Effect.map(({ result }) => result.pane)),
    ),
    inspectPaneLayout: Effect.fn("HerdrClient.inspectPaneLayout")((paneId: string) =>
      decoded(
        {
          args: ["pane", "layout", "--pane", paneId],
          operation: "inspect calling pane layout",
          mutation: false,
        },
        LayoutEnvelopeSchema,
      ).pipe(Effect.map(({ result }) => result.layout)),
    ),
    splitPane: Effect.fn("HerdrClient.splitPane")((input: HerdrSplitPaneInput) =>
      decoded(
        {
          args: [
            "pane",
            "split",
            input.parentPaneId,
            "--direction",
            input.direction,
            "--ratio",
            "0.5",
            "--cwd",
            input.cwd,
            "--no-focus",
          ],
          operation: "split BTW pane",
          mutation: true,
        },
        PaneEnvelopeSchema,
      ).pipe(Effect.map(({ result }) => result.pane)),
    ),
    inspectPaneProcessInfo: Effect.fn("HerdrClient.inspectPaneProcessInfo")((paneId: string) =>
      decoded(
        {
          args: ["pane", "process-info", "--pane", paneId],
          operation: "inspect BTW pane shell",
          mutation: false,
        },
        PaneProcessInfoEnvelopeSchema,
      ).pipe(Effect.map(({ result }) => result.process_info)),
    ),
    inspectLiveAgents: Effect.fn("HerdrClient.inspectLiveAgents")(() =>
      decoded(
        {
          args: ["api", "snapshot"],
          operation: "inspect live agents",
          mutation: false,
        },
        SnapshotEnvelopeSchema,
      ).pipe(Effect.map(({ result }) => result.snapshot.agents)),
    ),
    startSideSessionPi: Effect.fn("HerdrClient.startSideSessionPi")(
      (input: HerdrStartSideSessionInput) => {
        const markerArguments = herdrBtwParentMarkerArguments(
          input.parentSessionId,
          input.parentSessionPath,
          input.childSessionId,
        );
        const piArguments = [
          "--session",
          input.childSessionPath,
          ...(input.displayName === undefined ? [] : ["--name", input.displayName]),
          ...markerArguments,
        ];
        return decoded(
          {
            args: [
              "agent",
              "start",
              input.agentName,
              "--kind",
              "pi",
              "--pane",
              input.paneId,
              "--timeout",
              "60000",
              "--",
              ...piArguments,
            ],
            operation: "start side-session Pi",
            mutation: true,
            timeoutMillis: START_TIMEOUT_MILLIS,
            confirmedRejectionCodes: ["agent_pane_busy"],
          },
          AgentEnvelopeSchema,
        ).pipe(Effect.map(({ result }) => result.agent));
      },
    ),
    promptSideSessionPi: Effect.fn("HerdrClient.promptSideSessionPi")(
      (agentName: string, prompt: string) =>
        run({
          args: ["agent", "prompt", agentName, prompt],
          operation: "prompt side-session Pi",
          mutation: true,
        }).pipe(Effect.asVoid),
    ),
    focusSideSessionPi: Effect.fn("HerdrClient.focusSideSessionPi")((agentName: string) =>
      run({
        args: ["agent", "focus", agentName],
        operation: "focus side-session Pi",
        mutation: true,
      }).pipe(Effect.asVoid),
    ),
  };
};
