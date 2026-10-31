import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { firstLineMessage } from "pi-cosmic-core/message-text";
import { nodePath } from "pi-cosmic-core/platform/node-builtins";
import {
  acquireBoundedProcessRunner,
  nodeProcessLayer,
  type BoundedProcessResult,
  type BoundedProcessRunner,
} from "pi-cosmic-core/platform/process";
import { sanitizeDiagnosticContent } from "pi-cosmic-core/security";
import type { ChildCommand, RexLocation } from "./launch.ts";

const COMMAND_TIMEOUT_MILLIS = 15_000;
const PROCESS_CLEANUP_MILLIS = 1_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export class RexBtwError extends Schema.TaggedError<
  RexBtwError,
  { readonly brand: unique symbol }
>()("RexBtwError", {
  message: Schema.String,
  /** `uncertain`: Rex may have opened a pane. `anchorMissing`: the anchor pane no longer exists. */
  reason: Schema.Literals(["failed", "uncertain", "anchorMissing"] as const),
}) {}

export const isRexBtwError = Schema.is(RexBtwError);

const SizeSchema = Schema.fromJsonString(
  Schema.Struct({ columns: Schema.Int.check(Schema.isGreaterThan(0)) }),
);
const SplitSchema = Schema.fromJsonString(
  Schema.Struct({
    block_ids: Schema.Tuple([Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))]),
  }),
);

export interface RexSplitInput {
  readonly sessionId: string;
  readonly anchorBlockId: string;
  readonly direction: "right" | "below";
  readonly cwd: string;
  readonly command: ChildCommand;
}

// The CLI needs only its server address and ordinary process variables. The new pane's
// environment comes from the Rex server, not from this process.
const ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
]);

const selectEnvironment = (source: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv =>
  Rec.fromEntries(
    Arr.flatMap(Rec.toEntries(source), ([key, value]) =>
      value !== undefined &&
      (ENVIRONMENT_KEYS.has(key) ||
        Fn.pipe(key, Str.startsWith("REX_")) ||
        Fn.pipe(key, Str.startsWith("XDG_")))
        ? ([[key, value]] as const)
        : [],
    ),
  );

const rexExecutable = (environment: Readonly<NodeJS.ProcessEnv>): string =>
  environment.REX_BIN_DIR ? nodePath.join(environment.REX_BIN_DIR, "rex") : "rex";

const failure = (reason: RexBtwError["reason"], message: string) =>
  RexBtwError.make({ reason, message });

const exitDetail = (output: BoundedProcessResult): string => {
  const reason = firstLineMessage(
    sanitizeDiagnosticContent(output.stderr || output.stdout, { maximumLength: 2_000 }),
    "",
  );
  return reason ? `: ${Fn.pipe(reason, Str.replace(/^Error:\s*/u, ""))}` : "";
};

// Rex resolves targets before acting, so this message proves nothing was created.
const isMissingBlock = (output: BoundedProcessResult, blockId: string): boolean =>
  Fn.pipe(output.stderr, Str.includes(`block target ${JSON.stringify(blockId)} not found`));

const decode = <A>(
  schema: Schema.Codec<A, string>,
  stdout: string,
  error: RexBtwError,
): Effect.Effect<A, RexBtwError> =>
  Schema.decodeEffect(schema)(stdout).pipe(Effect.mapError(() => error));

export const makeRexClient = (
  sourceEnvironment: Readonly<NodeJS.ProcessEnv>,
  processRunner: BoundedProcessRunner,
) => {
  const environment = selectEnvironment(sourceEnvironment);
  const executable = rexExecutable(sourceEnvironment);

  /** Runs one command; `mutation` marks failures after spawn as possibly applied. */
  const run = (
    args: ReadonlyArray<string>,
    action: string,
    blockId: string,
    mutation: boolean,
  ): Effect.Effect<string, RexBtwError> =>
    processRunner({
      executable,
      args,
      environment,
      stdoutLimitBytes: MAX_OUTPUT_BYTES,
      stderrLimitBytes: MAX_OUTPUT_BYTES,
      timeoutMillis: COMMAND_TIMEOUT_MILLIS,
      cleanupTimeoutMillis: PROCESS_CLEANUP_MILLIS,
      detached: false,
    }).pipe(
      Effect.mapError((error) =>
        mutation && error.operation !== "spawn"
          ? failure("uncertain", `Rex may have opened ${action}, but couldn't confirm it`)
          : failure("failed", `Couldn't run Rex to open ${action}`),
      ),
      Effect.flatMap((output) => {
        if (output.overflowed || output.timedOut || output.cleanupUnconfirmed)
          return Effect.fail(
            mutation
              ? failure("uncertain", `Rex may have opened ${action}, but couldn't confirm it`)
              : failure("failed", `Rex didn't answer while opening ${action}`),
          );
        if (output.code === 0) return Effect.succeed(output.stdout);
        if (isMissingBlock(output, blockId))
          return Effect.fail(failure("anchorMissing", `Rex couldn't find pane ${blockId}`));
        return Effect.fail(
          mutation
            ? failure(
                "uncertain",
                `Rex may have opened ${action}, but reported an error${exitDetail(output)}`,
              )
            : failure("failed", `Rex couldn't open ${action}${exitDetail(output)}`),
        );
      }),
    );

  return {
    paneColumns: Effect.fn("RexClient.paneColumns")(function* (location: RexLocation) {
      const stdout = yield* run(
        ["block", "call", "-s", location.sessionId, "-b", location.blockId, "size"],
        "a BTW pane",
        location.blockId,
        false,
      );
      const size = yield* decode(
        SizeSchema,
        stdout,
        failure("failed", "Rex sent an unexpected pane size"),
      );
      return size.columns;
    }),
    split: Effect.fn("RexClient.split")(function* (input: RexSplitInput) {
      const stdout = yield* run(
        [
          "split",
          "-s",
          input.sessionId,
          "-b",
          input.anchorBlockId,
          "--split",
          input.direction,
          "-c",
          input.cwd,
          "--label",
          "btw",
          "--json",
          ...(input.command.startsShell ? ["--shell=none"] : []),
          "--",
          ...input.command.argv,
        ],
        "a BTW pane",
        input.anchorBlockId,
        true,
      );
      const split = yield* decode(
        SplitSchema,
        stdout,
        failure("uncertain", "Rex opened a BTW pane but sent an unexpected reply"),
      );
      return split.block_ids[0];
    }),
  };
};

export type RexClientContract = ReturnType<typeof makeRexClient>;

export class RexClient extends Context.Service<RexClient, RexClientContract>()(
  "pi-rex-btw/rex/RexClient",
) {
  static layer(environment: Readonly<NodeJS.ProcessEnv>) {
    return Layer.effect(
      this,
      Effect.map(acquireBoundedProcessRunner, (runner) => makeRexClient(environment, runner)),
    ).pipe(Layer.provide(nodeProcessLayer));
  }
}
