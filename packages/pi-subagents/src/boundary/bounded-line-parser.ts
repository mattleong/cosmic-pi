// Node stream/StringDecoder ownership is intentionally isolated at this boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
import { StringDecoder } from "node:string_decoder";
import * as Queue from "effect/Queue";

export interface ByteBoundedQueueRoom<A extends object> {
  readonly offer: (value: A, bytes: number) => boolean;
  readonly acknowledge: (value: A) => void;
  readonly queuedBytes: () => number;
}

/**
 * Weight queue ownership by bytes until the downstream consumer explicitly acknowledges an item.
 * Count-bounded Effect queues remain the final item-count guard; this room prevents each retained
 * item from independently carrying a maximum-sized transport frame.
 */
export function makeByteBoundedQueueRoom<A extends object, E>(
  queue: Queue.Enqueue<A, E>,
  maximumQueuedBytes: number,
  onOverflow: () => void,
): ByteBoundedQueueRoom<A> {
  const weights = new WeakMap<A, number>();
  let retainedBytes = 0;
  let overflowed = false;

  return {
    offer: (value, bytes) => {
      const weight = Math.max(0, Math.floor(bytes));
      if (overflowed) return false;
      if (retainedBytes + weight > maximumQueuedBytes) {
        overflowed = true;
        onOverflow();
        return false;
      }
      if (!Queue.offerUnsafe(queue, value)) return false;
      if (weight > 0) {
        weights.set(value, weight);
        retainedBytes += weight;
      }
      return true;
    },
    acknowledge: (value) => {
      const weight = weights.get(value);
      if (weight === undefined) return;
      weights.delete(value);
      retainedBytes = Math.max(0, retainedBytes - weight);
    },
    queuedBytes: () => retainedBytes,
  };
}

export interface BoundedLineParserOptions {
  readonly maxLineBytes: number;
  readonly maxQueuedBytes: number;
  readonly onLine: (line: string) => void;
  readonly onOverflow: () => void;
}

/**
 * Attach one bounded UTF-8 line room to a Node readable stream.
 *
 * Both a single unterminated frame and aggregate chunks queued during a re-entrant data callback
 * are bounded. The decoder tail and a final unterminated frame are flushed on end/close.
 */
export function attachBoundedLineParser(
  stream: NodeJS.ReadableStream,
  options: BoundedLineParserOptions,
): () => void {
  const decoder = new StringDecoder("utf8");
  const chunks: Buffer[] = [];
  let queuedBytes = 0;
  let buffered = "";
  let draining = false;
  let overflowed = false;
  let finalized = false;
  let detached = false;

  const overflow = () => {
    if (overflowed || detached) return;
    overflowed = true;
    chunks.length = 0;
    queuedBytes = 0;
    buffered = "";
    options.onOverflow();
  };

  const emitFrames = (final: boolean) => {
    while (!overflowed) {
      const index = buffered.indexOf("\n");
      if (index < 0) break;
      let line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (Buffer.byteLength(line, "utf8") > options.maxLineBytes) {
        overflow();
        return;
      }
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) options.onLine(line);
    }
    if (overflowed) return;
    if (Buffer.byteLength(buffered, "utf8") > options.maxLineBytes) {
      overflow();
      return;
    }
    if (!final || !buffered) return;
    let line = buffered;
    buffered = "";
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line) options.onLine(line);
  };

  const drain = () => {
    if (draining || overflowed || detached) return;
    draining = true;
    try {
      while (chunks.length > 0 && !overflowed) {
        const chunk = chunks.shift();
        if (!chunk) break;
        queuedBytes -= chunk.length;
        buffered += decoder.write(chunk);
        emitFrames(false);
      }
    } finally {
      draining = false;
    }
  };

  const onData = (value: Buffer | string) => {
    if (overflowed || finalized || detached) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    queuedBytes += chunk.length;
    if (queuedBytes > options.maxQueuedBytes) {
      overflow();
      return;
    }
    chunks.push(chunk);
    drain();
  };

  const finalize = () => {
    if (finalized || detached) return;
    finalized = true;
    drain();
    if (overflowed) return;
    buffered += decoder.end();
    emitFrames(true);
  };

  stream.on("data", onData);
  stream.once("end", finalize);
  stream.once("close", finalize);

  return () => {
    if (detached) return;
    detached = true;
    stream.off("data", onData);
    stream.off("end", finalize);
    stream.off("close", finalize);
    chunks.length = 0;
    queuedBytes = 0;
    buffered = "";
  };
}
