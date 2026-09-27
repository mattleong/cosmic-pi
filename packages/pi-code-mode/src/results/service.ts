import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Random from "effect/Random";
import {
  RESULT_MAX_BYTES,
  RESULT_MAX_ENTRIES,
  RESULT_SESSION_BYTES,
  type ExecutionOutcome,
  type PreparedResult,
  type ResultArtifact,
} from "./model.ts";

interface Registry {
  readonly open: boolean;
  readonly sequence: number;
  readonly entries: ReadonlyArray<ResultArtifact>;
}
export interface ResultsContract {
  /** Validates and prices an artifact without storing, charging, identifying or exposing it. */
  readonly prepare: (
    text: string,
    outcome: ExecutionOutcome,
    kind?: ResultArtifact["kind"],
  ) => Effect.Effect<PreparedResult | undefined>;
  /** Prepares and immediately commits, for callers without a later publication decision. */
  readonly put: (
    text: string,
    outcome: ExecutionOutcome,
    kind?: ResultArtifact["kind"],
  ) => Effect.Effect<string | undefined>;
  readonly get: (id: string) => Effect.Effect<ResultArtifact | undefined>;
}
export class CodeModeResults extends Context.Service<CodeModeResults, ResultsContract>()(
  "pi-code-mode/results/service/CodeModeResults",
) {
  static readonly layer = Layer.effect(
    CodeModeResults,
    Effect.gen(function* () {
      const prefix = `${(yield* Random.nextInt).toString(36)}-${(yield* Random.nextInt).toString(36)}`;
      const state = yield* Ref.make<Registry>({ open: true, sequence: 0, entries: [] });
      yield* Effect.acquireRelease(Effect.void, () =>
        Ref.update(state, (s) => ({ ...s, open: false, entries: [] })),
      );
      // Preparation does the size work and changes nothing. Commit is the only transition that
      // assigns an ID, charges storage and evicts, so eviction order follows publication order.
      const prepare: ResultsContract["prepare"] = (text, outcome, kind = "output") =>
        Ref.get(state).pipe(
          Effect.map((s): PreparedResult | undefined => {
            if (!s.open || text.length > RESULT_MAX_BYTES) return undefined;
            const bytes = new TextEncoder().encode(text).length;
            if (bytes > RESULT_MAX_BYTES) return undefined;
            // Charge both UTF-16 storage and UTF-8 projection plus fixed object overhead.
            const cost = text.length * 2 + bytes + 1024;
            // Read and consumed only inside the commit transition, so a handle publishes once.
            let unused = true;
            return {
              commit: Ref.modify(state, (current) => {
                if (!unused || !current.open) return [undefined, current];
                unused = false;
                const id = `cm-${prefix}-${current.sequence + 1}`;
                const entries = [...current.entries, { id, text, outcome, kind, cost }];
                let total = entries.reduce((sum, entry) => sum + entry.cost, 0);
                while (entries.length > RESULT_MAX_ENTRIES || total > RESULT_SESSION_BYTES) {
                  total -= entries.shift()!.cost;
                }
                return [id, { ...current, sequence: current.sequence + 1, entries }];
              }),
            };
          }),
        );
      return {
        prepare,
        put: (text, outcome, kind) =>
          Effect.flatMap(
            prepare(text, outcome, kind),
            (prepared) => prepared?.commit ?? Effect.succeed(undefined),
          ),
        get: (id) =>
          Ref.get(state).pipe(
            Effect.map((s) => (s.open ? s.entries.find((entry) => entry.id === id) : undefined)),
          ),
      } satisfies ResultsContract;
    }),
  );
}
