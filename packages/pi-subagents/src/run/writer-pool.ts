import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type { CanonicalWriterCwd, WriterLease } from "../boundary/writer-lease.ts";
import type { SubagentError } from "./errors.ts";

type WriterPoolState =
  | "pending"
  | "preparing"
  | "held"
  | "failed"
  | "releasing"
  | "paused"
  | "quarantined";

export interface WriterPoolView {
  readonly cwd: CanonicalWriterCwd;
  readonly state: WriterPoolState;
  readonly members: ReadonlySet<string>;
  readonly violationRunIds: ReadonlySet<string>;
  readonly admissionPaused: boolean;
  readonly pauseReason: string | undefined;
}

export class WriterPoolEntry implements WriterPoolView {
  readonly #members = new Set<string>();
  readonly #violationRunIds = new Set<string>();
  #state: WriterPoolState = "pending";
  #lease: WriterLease | undefined;
  #preparationError: SubagentError | undefined;
  #releaseAuthorized = false;
  #admissionPaused = false;
  #pauseReason: string | undefined;

  readonly cwd: CanonicalWriterCwd;
  readonly leaseScope: Scope.Closeable;
  readonly preparationSettled: Deferred.Deferred<void, SubagentError>;

  constructor(
    cwd: CanonicalWriterCwd,
    leaseScope: Scope.Closeable,
    preparationSettled: Deferred.Deferred<void, SubagentError>,
  ) {
    this.cwd = cwd;
    this.leaseScope = leaseScope;
    this.preparationSettled = preparationSettled;
  }

  get members(): ReadonlySet<string> {
    return this.#members;
  }

  get violationRunIds(): ReadonlySet<string> {
    return this.#violationRunIds;
  }

  get state(): WriterPoolState {
    return this.#state;
  }

  get lease(): WriterLease | undefined {
    return this.#lease;
  }

  get preparationError(): SubagentError | undefined {
    return this.#preparationError;
  }

  get releaseAuthorized(): boolean {
    return this.#releaseAuthorized;
  }

  get admissionPaused(): boolean {
    return this.#admissionPaused;
  }

  get pauseReason(): string | undefined {
    return this.#pauseReason;
  }

  joinLocked(runId: string): void {
    this.#members.add(runId);
  }

  claimPreparationLocked(): boolean {
    if (this.#state !== "pending") return false;
    this.#state = "preparing";
    return true;
  }

  adoptLeaseLocked(lease: WriterLease): boolean {
    if (this.#state !== "preparing") return false;
    this.#lease = lease;
    return true;
  }

  completePreparationLocked(lease: WriterLease): void {
    if (this.#state !== "preparing") return;
    this.#lease = lease;
    this.#state = "held";
    Deferred.doneUnsafe(this.preparationSettled, Effect.void);
  }

  failPreparationLocked(error: SubagentError): void {
    if (this.#state !== "preparing") return;
    this.#state = "failed";
    this.#preparationError = error;
    Deferred.doneUnsafe(this.preparationSettled, Effect.fail(error));
  }

  detachAfterCleanupLocked(runId: string): Scope.Closeable | undefined {
    if (!this.#members.has(runId)) return undefined;
    if (this.#members.size > 1) {
      this.#members.delete(runId);
      return undefined;
    }
    this.#state = "releasing";
    if (this.#lease) this.#releaseAuthorized = true;
    return this.leaseScope;
  }

  completeReleaseLocked(runId: string): boolean {
    if (this.#state !== "releasing") return false;
    this.#members.delete(runId);
    this.#lease = undefined;
    if (this.#admissionPaused) this.#state = "paused";
    return true;
  }

  pauseAdmissionLocked(runId: string, message: string): void {
    this.#admissionPaused = true;
    this.#violationRunIds.add(runId);
    this.#pauseReason = message;
  }

  resumeAdmissionLocked(): void {
    this.#admissionPaused = false;
    this.#violationRunIds.clear();
    this.#pauseReason = undefined;
  }

  quarantineLocked(): void {
    this.#state = "quarantined";
    this.#admissionPaused = true;
    this.#pauseReason = "A writer process or lease cleanup could not be confirmed.";
  }
}

export interface WriterPoolLookup {
  readonly size: number;
  readonly get: (digest: string) => WriterPoolView | undefined;
  readonly values: () => Iterable<WriterPoolView>;
}

export class WriterPools implements WriterPoolLookup {
  readonly #pools = new Map<string, WriterPoolEntry>();

  get size(): number {
    return this.#pools.size;
  }

  get(digest: string): WriterPoolEntry | undefined {
    return this.#pools.get(digest);
  }

  values(): Iterable<WriterPoolEntry> {
    return this.#pools.values();
  }

  joinLocked(cwd: CanonicalWriterCwd, runId: string): Effect.Effect<WriterPoolEntry> {
    return Effect.gen({ self: this }, function* () {
      let pool = this.#pools.get(cwd.digest);
      if (!pool) {
        pool = new WriterPoolEntry(
          cwd,
          yield* Scope.make(),
          yield* Deferred.make<void, SubagentError>(),
        );
        this.#pools.set(cwd.digest, pool);
      }
      pool.joinLocked(runId);
      return pool;
    });
  }

  completeReleaseLocked(pool: WriterPoolEntry, runId: string): boolean {
    if (!pool.completeReleaseLocked(runId)) return false;
    if (!pool.admissionPaused) this.removeLocked(pool);
    return true;
  }

  resumeAdmissionLocked(pool: WriterPoolEntry): void {
    pool.resumeAdmissionLocked();
    if (pool.state === "paused" && pool.members.size === 0) this.removeLocked(pool);
  }

  private removeLocked(pool: WriterPoolEntry): void {
    if (this.#pools.get(pool.cwd.digest) === pool) this.#pools.delete(pool.cwd.digest);
  }
}

export const writerPoolUnavailable = (pool: WriterPoolView | undefined): boolean =>
  pool?.state === "failed" ||
  pool?.state === "quarantined" ||
  pool?.state === "releasing" ||
  pool?.state === "paused" ||
  pool?.admissionPaused === true;
