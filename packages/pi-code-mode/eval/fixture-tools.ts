/** Evaluation-only SDK tool boundary, applied to direct AND nested definitions. */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { makeNestedPiToolDefinitions } from "../src/boundary/host-builtin-tools.ts";
import { evaluationError, FixtureBoundaryError } from "./errors.ts";
import { fixturePathEffect } from "./host-files.ts";

export { FixtureBoundaryError } from "./errors.ts";

export interface DispatchMetrics {
  nestedCalls: number;
  nestedSucceeded: number;
  nestedErrors: number;
  nestedOutputBytes: number;
  boundaryViolations: number;
  nativeTruncations: number;
}

const Input = Schema.Record(Schema.String, Schema.Unknown);
const PathInput = Schema.Struct({ path: Schema.optionalKey(Schema.String) });
const NativeDetails = Schema.Struct({
  truncation: Schema.optionalKey(Schema.Struct({ truncated: Schema.Boolean })),
});
export const freshDispatchMetrics = (): DispatchMetrics => ({
  nestedCalls: 0,
  nestedSucceeded: 0,
  nestedErrors: 0,
  nestedOutputBytes: 0,
  boundaryViolations: 0,
  nativeTruncations: 0,
});

/** Compatibility entry for SDK consumers; application effects use fixturePathEffect. */
export function fixturePath(root: string, path: string): Promise<string> {
  return Effect.runPromise(
    fixturePathEffect(root, path).pipe(Effect.provide(nodeFilePlatformLayer)),
  );
}

export function fixtureDefinitions(root: string, metrics: DispatchMetrics, nested: boolean) {
  const definitions = makeNestedPiToolDefinitions(root);
  const guard = (name: keyof typeof definitions) => {
    const definition = definitions[name];
    if (!definition) throw evaluationError("setup", "Missing evaluation tool definition.");
    return {
      ...definition,
      execute: (...args: Parameters<typeof definition.execute>) => {
        // These counters are synchronous SDK ingress/settlement projections. No counter
        // read-modify-write spans a yield, including concurrent interpreter dispatch.
        if (nested) metrics.nestedCalls++;
        const dispatch = Effect.gen(function* () {
          if (!["read", "grep", "find", "ls"].includes(name))
            return yield* new FixtureBoundaryError();
          const input = yield* Schema.decodeUnknownEffect(Input)(args[1]).pipe(
            Effect.mapError(() => evaluationError("dispatch")),
          );
          const { path } = yield* Schema.decodeEffect(PathInput)(input).pipe(
            Effect.mapError(() => evaluationError("dispatch")),
          );
          const canonical = yield* fixturePathEffect(root, path ?? ".");
          // Pass the checked path, not the original spelling. Pi normalizes leading @,
          // whitespace, and home aliases differently from Path.resolve().
          const result = yield* Effect.tryPromise({
            try: (signal) =>
              definition.execute(args[0], { ...input, path: canonical }, signal, args[3], args[4]),
            catch: () => evaluationError("dispatch"),
          });
          const truncated = yield* Schema.decodeUnknownEffect(NativeDetails)(result.details).pipe(
            Effect.map((details) => details.truncation?.truncated ?? false),
            Effect.orElseSucceed(() => false),
          );
          if (truncated) metrics.nativeTruncations++;
          if (nested) {
            metrics.nestedSucceeded++;
            metrics.nestedOutputBytes += result.content.reduce(
              (sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text) : 0),
              0,
            );
          }
          return result;
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (error instanceof FixtureBoundaryError) metrics.boundaryViolations++;
            }),
          ),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (nested && Exit.isFailure(exit)) metrics.nestedErrors++;
            }),
          ),
          Effect.provide(nodeFilePlatformLayer),
        );
        // Pi requires Promise definitions. Its signal owns the entire checked dispatch.
        return Effect.runPromise(dispatch, { signal: args[2] });
      },
    };
  };
  // Shells and mutations stay refused even though the real catalog describes them.
  // The fixed evaluation instruction discloses this restriction identically in both arms.
  return {
    read: guard("read"),
    grep: guard("grep"),
    find: guard("find"),
    ls: guard("ls"),
    bash: guard("bash"),
    edit: guard("edit"),
    write: guard("write"),
  };
}
