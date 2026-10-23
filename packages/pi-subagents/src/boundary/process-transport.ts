import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Arr from "effect/Array";
import {
  confirmProcessGroupExit,
  guardProcessGroupAtHostExit,
  nodeSpawn,
  type NodeChildProcess,
} from "pi-cosmic-core";
import { cleanupFailureDiagnostic } from "../run/cleanup-diagnostic.ts";
import type { BackendCleanupVerifier } from "../backend/model.ts";
import type { SubagentCleanupDiagnostic } from "../run/model.ts";
import { processCauseError, type SubagentProcessError } from "../run/errors.ts";
import { attachBoundedLineParser, type OversizedLine } from "./bounded-line-parser.ts";
import { detachedDescendantGroups, terminateProcessTree } from "./process-tree.ts";
import { decodeUnknownJsonOption } from "./wire-shared.ts";

export const MAX_PROCESS_LINE_BYTES = 4 * 1024 * 1024;
const encodeFrame = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;
// The byte budget bounds memory for ordinary output; the count only bounds per-event overhead
// for floods of tiny lines, so it must stay far above any burst of streaming deltas.
const EVENT_CAPACITY = 65_536;
const WRITE_TIMEOUT = "10 seconds";

export interface ProcessExit {
  readonly exitCode: number | null;
  readonly signal?: string;
  readonly stderr: string;
}

export type ProcessWireEvent<Message> =
  | Message
  | { readonly type: "protocol_error"; readonly message: string }
  | ({ readonly type: "oversized_line" } & OversizedLine);

export interface ProcessTransportHandle<Message, Frame> {
  readonly cleanupVerifier?: BackendCleanupVerifier | undefined;
  readonly pid: number;
  readonly events: Queue.Dequeue<ProcessWireEvent<Message>, Cause.Done>;
  readonly acknowledge: (event: ProcessWireEvent<Message>) => void;
  readonly awaitExit: Effect.Effect<ProcessExit, SubagentProcessError>;
  readonly send: (frame: Frame) => Effect.Effect<void, SubagentProcessError>;
  readonly terminate: (mode: "graceful" | "force") => Effect.Effect<void, SubagentProcessError>;
}

const processCleanupDiagnostic = (
  phase: SubagentCleanupDiagnostic["phase"],
  failure: SubagentProcessError,
) => cleanupFailureDiagnostic(phase, Cause.fail(failure));

const observeCleanupPhase = <A, E, R>(
  phase: SubagentCleanupDiagnostic["phase"],
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(Effect.catchCause((cause) => Effect.fail(cleanupFailureDiagnostic(phase, cause))));

const cleanupUnconfirmed = (
  message = "Process tree exit was not confirmed after forced termination.",
) =>
  processCauseError("confirm subagent process cleanup", new Error(message), "cleanup_unconfirmed");

export interface ProcessTransportRuntime {
  readonly spawn: (...args: Parameters<typeof nodeSpawn>) => NodeChildProcess;
  readonly terminate: typeof terminateProcessTree;
  readonly confirmGroupExit: typeof confirmProcessGroupExit;
  readonly detachedGroups: typeof detachedDescendantGroups;
  readonly guardGroup: typeof guardProcessGroupAtHostExit;
}
const nodeRuntime: ProcessTransportRuntime = {
  spawn: nodeSpawn,
  terminate: terminateProcessTree,
  confirmGroupExit: confirmProcessGroupExit,
  detachedGroups: detachedDescendantGroups,
  guardGroup: guardProcessGroupAtHostExit,
};

interface ProcessTransportOptions<Message, Frame, Attachment> {
  readonly spawn: (spawn: ProcessTransportRuntime["spawn"]) => NodeChildProcess;
  readonly label: string;
  readonly error: (operation: string, cause?: unknown, code?: string) => SubagentProcessError;
  readonly message: (value: Schema.Json) => Message;
  readonly maxOutboundBytes?: number;
  readonly terminateOnParserOverflow: boolean;
  /** Writers must not release ownership while a command the child detached may still write. */
  readonly confirmDetachedDescendants: boolean;
  readonly synchronousWriteFailure: "not_sent" | "defect";
  readonly requestAbort?: (
    send: (frame: Frame) => Effect.Effect<void, SubagentProcessError>,
  ) => Effect.Effect<void>;
  readonly attach: (
    child: NodeChildProcess,
    offer: (event: ProcessWireEvent<Message>, bytes?: number) => void,
  ) => Attachment;
}

export const acquireProcessTransport = Effect.fn("ProcessTransport.acquire")(function* <
  Message extends object,
  Frame,
  Attachment extends { readonly detach: () => void },
>(
  options: ProcessTransportOptions<Message, Frame, Attachment>,
  runtime: ProcessTransportRuntime = nodeRuntime,
) {
  const events = yield* Queue.dropping<ProcessWireEvent<Message>, Cause.Done>(EVENT_CAPACITY);
  const ready = yield* Deferred.make<void, SubagentProcessError>();
  const exited = yield* Deferred.make<ProcessExit>();
  const runFork = yield* FiberSet.makeRuntime();
  const { label, error: processError } = options;
  const stderr: Buffer[] = [];
  const weights = new WeakMap<ProcessWireEvent<Message>, number>();
  let queuedBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  let spawned = false;
  let cleaned = false;
  let queueOverflowed = false;
  let backlogOverflowed = false;
  let stdinError: Error | undefined;

  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const child = yield* Effect.try({
        try: () => options.spawn(runtime.spawn),
        catch: (error) => processError("spawn", error),
      });
      const waitForExit = Deferred.await(exited).pipe(
        Effect.interruptible,
        Effect.as(true),
        Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed(false) }),
      );
      const detachedGroups = new Set<number>();
      const cleanupFailures = new Map<unknown, SubagentCleanupDiagnostic>();
      let detachedSnapshotComplete = !options.confirmDetachedDescendants;
      let detachedSnapshotFailure: SubagentCleanupDiagnostic | undefined;
      const failAttested = (evidence: SubagentCleanupDiagnostic) => {
        const failure = cleanupUnconfirmed(evidence.message);
        cleanupFailures.set(failure, evidence);
        return Effect.fail(failure);
      };
      const attest = <A, E, R>(
        phase: SubagentCleanupDiagnostic["phase"],
        effect: Effect.Effect<A, E, R>,
      ) =>
        effect.pipe(
          Effect.catchCause((cause) => {
            const evidence = cleanupFailureDiagnostic(phase, cause);
            return failAttested(evidence);
          }),
        );
      // Descendants reparent once the child dies, so they are recorded before any signal.
      const recordDetachedGroups = Effect.suspend(() =>
        options.confirmDetachedDescendants && child.pid && !settled
          ? runtime.detachedGroups(child.pid).pipe(
              Effect.map((groups) => {
                for (const group of groups) detachedGroups.add(group);
                // A table completed after leader exit cannot prove discovery was complete.
                if (!settled && child.exitCode === null && child.signalCode === null)
                  detachedSnapshotComplete = true;
              }),
            )
          : Effect.void,
      ).pipe(
        Effect.onError((cause) =>
          Effect.sync(() => {
            // A later leader exit or successful table must not erase incomplete discovery.
            detachedSnapshotFailure ??= cleanupFailureDiagnostic("descendant-snapshot", cause);
          }),
        ),
      );
      // Keep the bounded snapshot and signal together even when a public caller is cancelled.
      const terminate = (mode: "graceful" | "force") =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const snapshot = yield* Effect.exit(recordDetachedGroups);
            yield* runtime
              .terminate(child, mode)
              .pipe(Effect.mapError((error) => processError("terminate", error)));
            // Incomplete discovery retains quarantine evidence, but must not leave the owned child alive.
            if (Exit.isFailure(snapshot)) return yield* Effect.failCause(snapshot.cause);
            return undefined;
          }),
        );
      // Pi's bash commands run in their own process groups and die only through its SIGTERM
      // handler, so even an overflow gives the child a grace period before SIGKILL.
      const force = () => {
        runFork(
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* Effect.exit(terminate("graceful"));
              yield* waitForExit;
              yield* Effect.exit(terminate("force"));
            }),
          ),
        );
      };
      const appendStderr = (chunk: Buffer) => {
        stderr.push(chunk);
        stderrBytes += chunk.byteLength;
        while (stderrBytes > MAX_STDERR_BYTES) {
          const first = stderr[0];
          if (!first) break;
          const excess = stderrBytes - MAX_STDERR_BYTES;
          if (first.byteLength <= excess) stderr.shift();
          else stderr[0] = first.subarray(excess);
          stderrBytes -= Math.min(first.byteLength, excess);
        }
      };
      const offer = (event: ProcessWireEvent<Message>, bytes = 0) => {
        if (backlogOverflowed) return;
        if (queuedBytes + bytes > MAX_QUEUED_BYTES) {
          backlogOverflowed = true;
          appendStderr(Buffer.from(`\n${label} event backlog exceeded ${MAX_QUEUED_BYTES} bytes.`));
          Queue.offerUnsafe(events, {
            type: "protocol_error",
            message: `${label} event backlog exceeded its byte budget.`,
          });
          return force();
        }
        if (Queue.offerUnsafe(events, event)) {
          weights.set(event, bytes);
          queuedBytes += bytes;
          return;
        }
        if (queueOverflowed) return;
        queueOverflowed = true;
        appendStderr(
          Buffer.from(`\n${label} event queue exceeded ${EVENT_CAPACITY} pending events.`),
        );
        force();
      };
      const acknowledge = (event: ProcessWireEvent<Message>) => {
        const weight = weights.get(event);
        if (weight === undefined) return;
        weights.delete(event);
        queuedBytes -= weight;
      };
      const detachStdout = child.stdout
        ? attachBoundedLineParser(child.stdout, {
            maxLineBytes: MAX_PROCESS_LINE_BYTES,
            maxQueuedBytes: MAX_QUEUED_BYTES,
            onLine: (line) => {
              const decoded = decodeUnknownJsonOption(line);
              offer(
                Option.isSome(decoded)
                  ? options.message(decoded.value)
                  : {
                      type: "protocol_error",
                      message: `${label} emitted malformed JSONL.`,
                    },
                Buffer.byteLength(line, "utf8") + 1,
              );
            },
            onOversizedLine: (line) =>
              offer(
                { type: "oversized_line", ...line },
                Buffer.byteLength(line.prefix, "utf8") + Buffer.byteLength(line.suffix, "utf8"),
              ),
            onOverflow: () => {
              offer({
                type: "protocol_error",
                message: `${label} output exceeded its bounded parser budget.`,
              });
              if (options.terminateOnParserOverflow) force();
            },
          })
        : () => {};
      const onStdoutError = (error: Error) => {
        appendStderr(Buffer.from(`\n${label} stdout error: ${error.message}\n`));
        offer({ type: "protocol_error", message: `${label} output stream failed.` });
      };
      const onStderrError = (error: Error) => {
        appendStderr(Buffer.from(`\n${label} stderr error: ${error.message}\n`));
        offer({ type: "protocol_error", message: `${label} diagnostic stream failed.` });
      };
      const onStdinError = (error: Error) => {
        stdinError = error;
      };
      const onSpawn = () => {
        spawned = true;
        Deferred.doneUnsafe(ready, Effect.void);
      };
      const attachment = options.attach(child, offer);
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        Queue.endUnsafe(events);
        Deferred.doneUnsafe(
          exited,
          Effect.succeed({
            exitCode,
            ...(signal && { signal }),
            stderr: Buffer.concat(stderr).toString("utf8"),
          }),
        );
      };
      const onError = (error: Error) => {
        Deferred.doneUnsafe(ready, Effect.fail(processError("spawn", error)));
        if (!spawned) finish(null, null);
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal);
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        detachStdout();
        child.stdout?.off("error", onStdoutError);
        child.stderr?.off("data", appendStderr);
        child.stderr?.off("error", onStderrError);
        child.stdin?.off("error", onStdinError);
        child.off("spawn", onSpawn);
        attachment.detach();
        child.off("error", onError);
        child.off("close", onClose);
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      };
      child.stdout?.on("error", onStdoutError);
      child.stderr?.on("data", appendStderr);
      child.stderr?.on("error", onStderrError);
      child.stdin?.on("error", onStdinError);
      child.once("spawn", onSpawn);
      child.once("error", onError);
      child.once("close", onClose);
      yield* Deferred.await(ready).pipe(Effect.onError(() => Effect.sync(cleanup)));
      const pid = child.pid;
      if (!pid) {
        cleanup();
        return yield* processError("spawn", "Process did not expose a pid.");
      }
      // Covers host exits that skip scope cleanup. Acquired before the release finalizer, the guard
      // lasts through cleanup; a group already gone when the child exits releases it early, so a
      // reused group ID is never killed.
      const exitGuard = yield* runtime.guardGroup(pid);
      runFork(
        Deferred.await(exited).pipe(
          Effect.andThen(runtime.confirmGroupExit(pid, 200)),
          Effect.flatMap((gone) => (gone ? exitGuard.release : Effect.void)),
        ),
      );
      const send = (frame: Frame) =>
        Effect.callback<void, SubagentProcessError>((resume) => {
          const notSent = (operation: string, cause: unknown) =>
            resume(Effect.fail(processError(operation, cause, "transport_not_sent")));
          const stdin = child.stdin;
          if (!stdin || stdin.destroyed || stdinError)
            return notSent("send frame to", stdinError ?? "Process input is closed.");
          let encoded: string;
          try {
            encoded = `${encodeFrame(frame)}\n`;
          } catch (error) {
            return notSent("encode frame for", error);
          }
          if (
            options.maxOutboundBytes !== undefined &&
            Buffer.byteLength(encoded, "utf8") > options.maxOutboundBytes
          )
            return notSent("encode frame for", "Frame exceeded limit.");
          try {
            stdin.write(encoded, (error) =>
              resume(
                error
                  ? Effect.fail(processError("send frame to", error, "transport_outcome_uncertain"))
                  : Effect.void,
              ),
            );
          } catch (error) {
            if (options.synchronousWriteFailure === "defect") resume(Effect.die(error));
            else notSent("send frame to", error);
          }
        }).pipe(
          Effect.timeoutOrElse({
            duration: WRITE_TIMEOUT,
            orElse: () =>
              Effect.fail(
                processError(
                  "send frame to",
                  `Transport write exceeded ${WRITE_TIMEOUT}; delivery may already have occurred.`,
                  "transport_outcome_uncertain",
                ),
              ),
          }),
        );
      const confirmDetachedGroupsExit = Effect.suspend(() =>
        Effect.forEach(
          [...detachedGroups],
          (group) =>
            runtime
              .confirmGroupExit(group, 2_000)
              .pipe(Effect.map((gone) => (gone ? [] : [group]))),
          { concurrency: "unbounded" },
        ),
      ).pipe(Effect.map((remaining) => remaining.flat()));
      const observe = Effect.gen(function* () {
        if (!settled && child.exitCode === null && child.signalCode === null)
          return yield* Effect.fail(
            processCleanupDiagnostic(
              "process-exit",
              cleanupUnconfirmed("The exact child process has not exited."),
            ),
          );
        if (detachedSnapshotFailure) return yield* Effect.fail(detachedSnapshotFailure);
        if (!detachedSnapshotComplete)
          return yield* Effect.fail(
            processCleanupDiagnostic(
              "descendant-snapshot",
              cleanupUnconfirmed("No complete pre-exit descendant snapshot was retained."),
            ),
          );
        yield* observeCleanupPhase(
          "process-group",
          runtime
            .confirmGroupExit(pid, 2_000)
            .pipe(
              Effect.flatMap((gone) =>
                gone
                  ? Effect.void
                  : cleanupUnconfirmed("The original process group is still present."),
              ),
            ),
        );
        const remaining = yield* observeCleanupPhase(
          "descendant-groups",
          confirmDetachedGroupsExit,
        );
        if (remaining.length > 0)
          return yield* Effect.fail(
            processCleanupDiagnostic(
              "descendant-groups",
              cleanupUnconfirmed("Recorded detached descendant groups are still present."),
            ),
          );
        return undefined;
      });
      const cleanupVerifier: BackendCleanupVerifier = {
        diagnostic: (reason) =>
          Cause.isDieReason(reason)
            ? cleanupFailures.get(reason.defect)
            : Cause.isFailReason(reason)
              ? cleanupFailures.get(reason.error)
              : undefined,
        canVerify: () => detachedSnapshotFailure === undefined && detachedSnapshotComplete,
        verify: observe,
      };
      const release = Effect.gen(function* () {
        yield* Effect.exit(recordDetachedGroups);
        yield* attest("backend-scope", options.requestAbort?.(send) ?? Effect.void);
        yield* Effect.sleep("100 millis");
        yield* Effect.exit(terminate("graceful"));
        if (yield* waitForExit) {
          yield* Effect.sleep("100 millis");
          yield* terminate("force").pipe(Effect.ignore);
        } else {
          yield* Effect.exit(terminate("force"));
          if (!(yield* waitForExit))
            return yield* detachedSnapshotFailure
              ? failAttested(detachedSnapshotFailure)
              : attest("process-exit", cleanupUnconfirmed());
        }
        if (detachedSnapshotFailure) return yield* failAttested(detachedSnapshotFailure);
        // A child that exited on its own was never snapshotted, and its descendants have
        // reparented, so nothing can show they are gone.
        if (!detachedSnapshotComplete)
          return yield* attest(
            "descendant-snapshot",
            cleanupUnconfirmed("No complete pre-exit descendant snapshot was retained."),
          );
        yield* attest(
          "process-group",
          runtime
            .confirmGroupExit(pid, 2_000)
            .pipe(Effect.flatMap((gone) => (gone ? Effect.void : cleanupUnconfirmed()))),
        );
        const remaining = yield* attest("descendant-groups", confirmDetachedGroupsExit);
        if (remaining.length > 0)
          return yield* attest(
            "descendant-groups",
            cleanupUnconfirmed(
              `Detached descendant process groups ${Arr.join(Arr.map(remaining, String), ", ")} were still running after the subagent exited.`,
            ),
          );
        return undefined;
      });
      yield* Effect.addFinalizer(() =>
        release.pipe(Effect.ensuring(Effect.sync(cleanup)), Effect.orDie),
      );
      return {
        pid,
        cleanupVerifier,
        events,
        acknowledge,
        awaitExit: Deferred.await(exited),
        send,
        terminate,
        attachment,
      };
    }),
  );
});
