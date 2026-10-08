// Node stream/StringDecoder ownership is intentionally isolated at this boundary.
import { StringDecoder } from "node:string_decoder";

/** Only the native event subscription contract is needed; this parser does not control flow. */
export interface BoundedLineInput {
  on(event: "data", listener: (value: Buffer | string) => void): void;
  once(event: "end" | "close", listener: () => void): void;
  off(
    event: "data" | "end" | "close",
    listener: ((value: Buffer | string) => void) | (() => void),
  ): void;
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
  stream: BoundedLineInput,
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

  const emitLine = (line: string) => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (text) options.onLine(text);
  };

  const emitFrames = (final: boolean) => {
    while (!overflowed) {
      const index = buffered.indexOf("\n");
      if (index < 0) break;
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (Buffer.byteLength(line, "utf8") > options.maxLineBytes) return overflow();
      emitLine(line);
    }
    if (overflowed) return;
    if (Buffer.byteLength(buffered, "utf8") > options.maxLineBytes) return overflow();
    if (!final || !buffered) return;
    const line = buffered;
    buffered = "";
    emitLine(line);
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
    if (queuedBytes > options.maxQueuedBytes) return overflow();
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
