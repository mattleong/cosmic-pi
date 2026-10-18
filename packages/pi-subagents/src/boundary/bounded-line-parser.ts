interface BoundedLineInput {
  on(event: "data", listener: (value: Buffer | string) => void): void;
  once(event: "end" | "close", listener: () => void): void;
  off(
    event: "data" | "end" | "close",
    listener: ((value: Buffer | string) => void) | (() => void),
  ): void;
}

/** A line longer than the parser keeps, summarized by its ends so a reader can classify it. */
export interface OversizedLine {
  readonly prefix: string;
  readonly suffix: string;
  readonly bytes: number;
}

interface BoundedLineParserOptions {
  readonly maxLineBytes: number;
  readonly maxQueuedBytes: number;
  readonly onLine: (line: string) => void;
  /** Receives oversized lines and keeps parsing after them. Without it, one overflows the parser. */
  readonly onOversizedLine?: (line: OversizedLine) => void;
  readonly onOverflow: () => void;
}

export const OVERSIZED_LINE_PREFIX_BYTES = 2 * 1024;
const OVERSIZED_LINE_SUFFIX_BYTES = 256;
const NEWLINE = 0x0a;

interface SkippedLine {
  readonly prefix: Buffer;
  suffix: Buffer;
  bytes: number;
}

const withTail = (tail: Buffer, segment: Buffer): Buffer => {
  if (segment.length >= OVERSIZED_LINE_SUFFIX_BYTES)
    return Buffer.from(segment.subarray(segment.length - OVERSIZED_LINE_SUFFIX_BYTES));
  const kept = tail.subarray(
    Math.max(0, tail.length - OVERSIZED_LINE_SUFFIX_BYTES + segment.length),
  );
  return Buffer.concat([kept, segment]);
};

const lineText = (bytes: Buffer): string => {
  const text = bytes.toString("utf8");
  return text.endsWith("\r") ? text.slice(0, -1) : text;
};

export function attachBoundedLineParser(
  stream: BoundedLineInput,
  options: BoundedLineParserOptions,
): () => void {
  const chunks: Buffer[] = [];
  let queuedBytes = 0;
  let line: Buffer[] = [];
  let lineBytes = 0;
  let skipped: SkippedLine | undefined;
  let draining = false;
  let overflowed = false;
  let finalized = false;
  let detached = false;

  const reset = () => {
    chunks.length = 0;
    queuedBytes = 0;
    line = [];
    lineBytes = 0;
    skipped = undefined;
  };

  const overflow = () => {
    if (overflowed || detached) return;
    overflowed = true;
    reset();
    options.onOverflow();
  };

  const append = (segment: Buffer) => {
    if (segment.length === 0) return;
    if (skipped) {
      skipped.bytes += segment.length;
      skipped.suffix = withTail(skipped.suffix, segment);
      return;
    }
    if (lineBytes + segment.length <= options.maxLineBytes) {
      line.push(segment);
      lineBytes += segment.length;
      return;
    }
    if (!options.onOversizedLine) return overflow();
    const parts = [...line, segment];
    const bytes = lineBytes + segment.length;
    const suffix = parts.reduce<Buffer>(withTail, Buffer.alloc(0));
    skipped = {
      prefix: Buffer.concat(parts, Math.min(bytes, OVERSIZED_LINE_PREFIX_BYTES)),
      suffix,
      bytes,
    };
    line = [];
    lineBytes = 0;
  };

  const finishLine = () => {
    const oversized = skipped;
    if (oversized) {
      skipped = undefined;
      options.onOversizedLine?.({
        prefix: oversized.prefix.toString("utf8"),
        suffix: lineText(oversized.suffix),
        bytes: oversized.bytes,
      });
      return;
    }
    if (lineBytes === 0) return;
    const text = lineText(Buffer.concat(line, lineBytes));
    line = [];
    lineBytes = 0;
    if (text) options.onLine(text);
  };

  const consume = (chunk: Buffer) => {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(NEWLINE, start);
      append(chunk.subarray(start, end < 0 ? chunk.length : end));
      if (end < 0 || overflowed) return;
      finishLine();
      if (overflowed || detached) return;
      start = end + 1;
    }
  };

  const drain = () => {
    if (draining || overflowed || detached) return;
    draining = true;
    try {
      for (let chunk = chunks.shift(); chunk; chunk = chunks.shift()) {
        queuedBytes -= chunk.length;
        consume(chunk);
        if (overflowed || detached) return;
      }
      if (finalized) finishLine();
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
    reset();
  };
}
