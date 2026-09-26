import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { invokeHostCallback, notifyListeners } from "pi-cosmic-core";
import { boundaryError } from "../client/errors.ts";
import {
  MCP_RESULT_LIMITS,
  type McpPreparedResult,
  type McpResultsContract,
  type McpResultsOptions,
  type McpRetentionOutcome,
} from "./model.ts";
import { normalizeResult, utf8Bytes } from "./normalize.ts";
import { projectPrepared } from "./projection.ts";

interface State {
  readonly entries: ReadonlyMap<string, McpPreparedResult>;
  readonly closed: boolean;
  readonly bytes: number;
  readonly generation: number;
}

const ceiling = (value: number | undefined, maximum: number): number =>
  value === undefined || !Number.isFinite(value)
    ? maximum
    : Math.max(0, Math.min(Math.floor(value), maximum));

export const makeMcpResults = (options: McpResultsOptions = {}) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const activation = Object.freeze({});
    // Weak identity evidence prevents an evicted prepared handle from resurrecting its ID.
    // Access stays inside the single synchronous Ref.modify retention transition.
    const settled = new WeakSet<McpPreparedResult>();
    const listeners = new Set<() => void>();
    // One signal per committed transition, even when that transition evicts many entries.
    // Consumers clear visible text synchronously and coalesce any subsequent local reads.
    const notify = () => notifyListeners(listeners);
    const maxEntries = ceiling(options.maxEntries, MCP_RESULT_LIMITS.entries);
    const maxBytes = ceiling(options.maxBytes, MCP_RESULT_LIMITS.retainedBytes);
    const state = yield* Ref.make<State>({
      entries: new Map(),
      closed: false,
      bytes: 0,
      generation: 0,
    });
    const current = (prepared: McpPreparedResult, snapshot: State): boolean =>
      !snapshot.closed &&
      prepared.activation === activation &&
      prepared.generation === snapshot.generation;
    const stale = () =>
      boundaryError("stale", "not-sent", "Result is unavailable or has been revoked.");

    const prepare: McpResultsContract["prepare"] = (input) =>
      Effect.gen(function* () {
        if (
          !/^[a-z][a-z.]{0,63}$/.test(input.action) ||
          utf8Bytes(input.owner) > 8_192 ||
          utf8Bytes(input.server) > 128
        ) {
          return yield* boundaryError(
            "invalid-input",
            "completed",
            "Completed result identity is invalid.",
          );
        }
        const snapshot = yield* Ref.get(state);
        if (snapshot.closed)
          return yield* boundaryError("denied", "completed", "Result activation is closed.");
        // Randomness and payload preparation never run in the caller's retention commit.
        const candidateId = yield* crypto.randomUUIDv4.pipe(Effect.orElseSucceed(() => undefined));
        const normalized = yield* Effect.sync(() => normalizeResult(input));
        const generation = snapshot.generation;
        // Conservative allowance for the UUID, activation marker, and generation metadata.
        const bytes = normalized.bytes + 256;
        let prepared: McpPreparedResult = {
          ...normalized,
          bytes,
          owner: input.owner,
          server: input.server,
          activation,
          generation,
        };
        if (candidateId !== undefined) prepared = { ...prepared, candidateId };
        return Object.freeze(prepared);
      });

    const retain: McpResultsContract["retain"] = (prepared) =>
      Effect.suspend(() => {
        let changed = false;
        return Ref.modify(state, (snapshot): [McpRetentionOutcome, State] => {
          if (!current(prepared, snapshot))
            return [{ status: "unretained", reason: "revoked" }, snapshot];
          if (prepared.outputLimited || prepared.bytes > MCP_RESULT_LIMITS.acceptedBytes)
            return [{ status: "unretained", reason: "output-limit" }, snapshot];
          if (prepared.candidateId === undefined)
            return [{ status: "unretained", reason: "unavailable" }, snapshot];
          if (maxEntries === 0 || prepared.bytes > maxBytes)
            return [{ status: "unretained", reason: "capacity" }, snapshot];
          const existing = snapshot.entries.get(prepared.candidateId);
          if (existing === prepared)
            return [{ status: "retained", resultId: prepared.candidateId }, snapshot];
          if (existing !== undefined || settled.has(prepared))
            return [{ status: "unretained", reason: "unavailable" }, snapshot];
          const entries = new Map(snapshot.entries);
          let bytes = snapshot.bytes;
          // Map insertion order is settlement order. Reads never refresh the eviction order.
          for (const [id, entry] of entries) {
            if (entries.size < maxEntries && bytes + prepared.bytes <= maxBytes) break;
            entries.delete(id);
            bytes -= entry.bytes;
          }
          entries.set(prepared.candidateId, prepared);
          settled.add(prepared);
          bytes += prepared.bytes;
          changed = true;
          return [
            { status: "retained", resultId: prepared.candidateId },
            { ...snapshot, entries, bytes },
          ];
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (changed) notify();
            }),
          ),
          Effect.uninterruptible,
        );
      });

    const project: McpResultsContract["project"] = (prepared, retention, projectionOptions) =>
      Effect.gen(function* () {
        const before = yield* Ref.get(state);
        if (!current(prepared, before))
          return yield* boundaryError(
            "denied",
            "completed",
            "Completed result publication was revoked.",
          );
        const effective =
          retention.status === "retained" && before.entries.get(retention.resultId) !== prepared
            ? { status: "unretained" as const, reason: "unavailable" as const }
            : retention;
        const execution = yield* projectPrepared(prepared, effective, projectionOptions);
        const after = yield* Ref.get(state);
        if (!current(prepared, after))
          return yield* boundaryError(
            "denied",
            "completed",
            "Completed result publication was revoked.",
          );
        // Eviction during projection cannot advertise a recoverable ID that no longer exists.
        if (effective.status === "retained" && after.entries.get(effective.resultId) !== prepared) {
          return yield* projectPrepared(
            prepared,
            { status: "unretained", reason: "unavailable" },
            projectionOptions,
          );
        }
        return execution;
      });

    const read: McpResultsContract["read"] = (input, projectionOptions, authorize) =>
      Effect.gen(function* () {
        const prepared = (yield* Ref.get(state)).entries.get(input.id);
        if (prepared === undefined) return yield* stale();
        yield* authorize(prepared.owner, prepared.server);
        const before = yield* Ref.get(state);
        if (!current(prepared, before) || before.entries.get(input.id) !== prepared)
          return yield* stale();
        const execution = yield* projectPrepared(
          prepared,
          { status: "retained", resultId: input.id },
          projectionOptions,
          input,
        );
        yield* authorize(prepared.owner, prepared.server);
        const after = yield* Ref.get(state);
        if (!current(prepared, after) || after.entries.get(input.id) !== prepared)
          return yield* stale();
        return execution;
      });

    const revoke: McpResultsContract["revoke"] = () =>
      Ref.update(state, (snapshot) => ({
        ...snapshot,
        entries: new Map(),
        bytes: 0,
        generation: snapshot.generation + 1,
      })).pipe(Effect.andThen(Effect.sync(notify)), Effect.uninterruptible);

    yield* Effect.addFinalizer(() =>
      Ref.update(state, (snapshot) => ({
        ...snapshot,
        closed: true,
        entries: new Map(),
        bytes: 0,
      })).pipe(
        Effect.andThen(
          Effect.sync(() => {
            notify();
            listeners.clear();
          }),
        ),
      ),
    );
    // The closed check and registration share one step, so a close cannot land between them.
    const subscribeChanges: McpResultsContract["subscribeChanges"] = (listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          if (Ref.getUnsafe(state).closed) invokeHostCallback(listener, undefined);
          else listeners.add(listener);
        }),
        () =>
          Effect.sync(() => {
            listeners.delete(listener);
          }),
      );
    return {
      prepare,
      retain,
      project,
      read,
      revoke,
      subscribeChanges,
    } satisfies McpResultsContract;
  });

export class McpResults extends Context.Service<McpResults, McpResultsContract>()(
  "pi-mcp/results/service/McpResults",
) {
  static readonly layer = (options: McpResultsOptions = {}): Layer.Layer<McpResults> =>
    Layer.effect(this, makeMcpResults(options)).pipe(Layer.provide(NodeCrypto.layer));
}
