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
  type ResultArtifact,
} from "./model.ts";

interface Registry {
  readonly open: boolean;
  readonly sequence: number;
  readonly entries: ReadonlyArray<ResultArtifact>;
}
export interface ResultsContract {
  readonly put: (
    text: string,
    outcome: ExecutionOutcome,
    kind?: ResultArtifact["kind"],
  ) => Effect.Effect<string | undefined>;
  readonly get: (id: string) => Effect.Effect<ResultArtifact | undefined>;
  readonly clear: Effect.Effect<void>;
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
      return {
        put: (text, outcome, kind = "output") =>
          Ref.modify(state, (s) => {
            if (!s.open || text.length > RESULT_MAX_BYTES) return [undefined, s];
            const bytes = new TextEncoder().encode(text).length;
            if (bytes > RESULT_MAX_BYTES) return [undefined, s];
            // Charge both UTF-16 storage and UTF-8 projection plus fixed object overhead.
            const cost = text.length * 2 + bytes + 1024;
            const id = `cm-${prefix}-${s.sequence + 1}`;
            const entries = [...s.entries, { id, text, outcome, kind, cost }];
            let total = entries.reduce((sum, entry) => sum + entry.cost, 0);
            while (entries.length > RESULT_MAX_ENTRIES || total > RESULT_SESSION_BYTES) {
              total -= entries.shift()!.cost;
            }
            return [id, { ...s, sequence: s.sequence + 1, entries }];
          }),
        get: (id) =>
          Ref.get(state).pipe(
            Effect.map((s) => (s.open ? s.entries.find((entry) => entry.id === id) : undefined)),
          ),
        clear: Ref.update(state, (s) => ({ ...s, open: false, entries: [] })),
      } satisfies ResultsContract;
    }),
  );
}
