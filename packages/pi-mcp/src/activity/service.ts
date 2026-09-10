import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { invokeHostCallback } from "pi-cosmic-core";
import { McpBoundaryError } from "../client/errors.ts";
import { McpServerIdSchema } from "../config/schema.ts";
import {
  MCP_ACTIVITY_PHASES,
  mcpActivityTerminal,
  type McpActivityEntry,
  type McpActivityFailure,
  type McpActivityHandle,
  type McpActivityOperation,
  type McpActivityPhase,
} from "./model.ts";

export const MCP_ACTIVITY_LIMITS = Object.freeze({ active: 128, terminal: 32 });
export interface McpActivityContract {
  readonly begin: (input: {
    readonly operation: McpActivityOperation;
    readonly server: string;
  }) => Effect.Effect<McpActivityHandle>;
  readonly update: (
    handle: McpActivityHandle,
    input: { readonly phase: McpActivityPhase },
  ) => Effect.Effect<void>;
  readonly finish: (
    handle: McpActivityHandle,
    input: McpActivityFailure & { readonly status: "done" | "failed" | "cancelled" },
  ) => Effect.Effect<void>;
  readonly snapshot: () => readonly McpActivityEntry[];
  /** Synchronous observers may enqueue local invalidation, never reenter operation owners. */
  readonly subscribe: (listener: () => void) => () => void;
}
interface State {
  readonly sequence: number;
  readonly revision: number;
  readonly entries: readonly McpActivityEntry[];
  readonly closed: boolean;
}
const failureSchema = Schema.Struct({
  kind: Schema.optionalKey(McpBoundaryError.fields.kind),
  reason: McpBoundaryError.fields.reason,
});
const freezeEntries = (entries: readonly McpActivityEntry[]): readonly McpActivityEntry[] =>
  Object.freeze(entries.map((entry) => Object.freeze(entry)));
const retain = (entries: readonly McpActivityEntry[], terminalLimit: number) => {
  let remaining = terminalLimit;
  return freezeEntries(
    entries
      .toReversed()
      .filter((entry) => !mcpActivityTerminal(entry) || remaining-- > 0)
      .toReversed(),
  );
};

/** An observational journal, not a task scheduler. Only the shared work owner calls begin. */
export const makeMcpActivity = (
  options: { readonly activeLimit?: number; readonly terminalLimit?: number } = {},
): Effect.Effect<McpActivityContract, never, Scope.Scope> =>
  Effect.gen(function* () {
    const boundedLimit = (value: number | undefined, maximum: number): number =>
      value !== undefined && Number.isSafeInteger(value)
        ? Math.max(1, Math.min(value, maximum))
        : maximum;
    const activeLimit = boundedLimit(options.activeLimit, MCP_ACTIVITY_LIMITS.active);
    const terminalLimit = boundedLimit(options.terminalLimit, MCP_ACTIVITY_LIMITS.terminal);
    const state = yield* SynchronizedRef.make<State>({
      sequence: 0,
      revision: 0,
      entries: Object.freeze([]),
      closed: false,
    });
    const handles = new WeakSet<McpActivityHandle>();
    const listeners = new Set<() => void>();
    const notify = Effect.sync(() => {
      for (const listener of listeners) invokeHostCallback(listener, undefined);
    });
    const commit = <A>(transition: (current: State) => readonly [A, State]) =>
      SynchronizedRef.modify(state, transition).pipe(Effect.tap(() => notify));
    yield* Effect.addFinalizer(() =>
      SynchronizedRef.update(state, (current) => ({
        ...current,
        closed: true,
        entries: Object.freeze([]),
      })).pipe(Effect.andThen(notify), Effect.andThen(Effect.sync(() => listeners.clear()))),
    );

    const begin: McpActivityContract["begin"] = (input) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* commit((current) => {
          const sequence = current.sequence + 1;
          const handle = Object.freeze({ id: `mcp-${sequence}` });
          handles.add(handle);
          if (
            current.closed ||
            !Schema.is(McpServerIdSchema)(input.server) ||
            !["auth", "connect", "refresh"].includes(input.operation) ||
            current.entries.filter((entry) => !mcpActivityTerminal(entry)).length >= activeLimit
          )
            return [handle, { ...current, sequence }];
          const revision = current.revision + 1;
          const entry: McpActivityEntry = {
            id: handle.id,
            revision: String(revision),
            operation: input.operation,
            server: input.server.slice(0, 128),
            phase: "starting",
            status: "running",
            startedAt: now,
            updatedAt: now,
          };
          return [
            handle,
            { ...current, sequence, revision, entries: freezeEntries([...current.entries, entry]) },
          ];
        });
      });
    const update: McpActivityContract["update"] = (handle, input) =>
      Effect.gen(function* () {
        if (!handles.has(handle) || !Object.hasOwn(MCP_ACTIVITY_PHASES, input.phase)) return;
        const now = yield* Clock.currentTimeMillis;
        yield* commit((current) => {
          const entry = current.entries.find((item) => item.id === handle.id);
          if (
            current.closed ||
            !entry ||
            mcpActivityTerminal(entry) ||
            entry.phase === input.phase ||
            entry.status === "stopping"
          )
            return [undefined, current];
          const phase = input.phase;
          const status =
            phase === "stopping"
              ? "stopping"
              : phase === "browser-approval" && entry.operation === "auth"
                ? "needs-input"
                : "running";
          const revision = current.revision + 1;
          const updated: McpActivityEntry = {
            ...entry,
            revision: String(revision),
            phase,
            status,
            updatedAt: now,
          };
          return [
            undefined,
            {
              ...current,
              revision,
              entries: freezeEntries(
                current.entries.map((item) => (item === entry ? updated : item)),
              ),
            },
          ];
        });
      });
    const finish: McpActivityContract["finish"] = (handle, input) =>
      Effect.gen(function* () {
        if (!handles.has(handle) || !["done", "failed", "cancelled"].includes(input.status)) return;
        const now = yield* Clock.currentTimeMillis;
        yield* commit((current) => {
          const entry = current.entries.find((item) => item.id === handle.id);
          if (current.closed || !entry || mcpActivityTerminal(entry)) return [undefined, current];
          const revision = current.revision + 1;
          let finished: McpActivityEntry = {
            ...entry,
            revision: String(revision),
            status: input.status,
            updatedAt: now,
            endedAt: now,
          };
          if (input.status === "failed") {
            const failure = Option.getOrElse(
              Schema.decodeUnknownOption(failureSchema)(input),
              () => ({ kind: "unavailable" as const }),
            );
            finished = { ...finished, failure: Object.freeze(failure) };
          }
          return [
            undefined,
            {
              ...current,
              revision,
              // Terminal retention follows completion order, not when work began.
              entries: retain(
                [...current.entries.filter((item) => item !== entry), finished],
                terminalLimit,
              ),
            },
          ];
        });
      });
    return {
      begin,
      update,
      finish,
      // The pinned synchronous read exposes only deeply frozen journal data, not its Ref.
      snapshot: () => SynchronizedRef.getUnsafe(state).entries,
      subscribe: (listener) => {
        if (SynchronizedRef.getUnsafe(state).closed) return () => undefined;
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  });

export class McpActivity extends Context.Service<McpActivity, McpActivityContract>()(
  "pi-mcp/activity/service/McpActivity",
) {
  static layer = () => Layer.effect(McpActivity, makeMcpActivity());
}
