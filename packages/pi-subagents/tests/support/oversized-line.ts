import { EventEmitter } from "node:events";
import * as Schema from "effect/Schema";
import {
  attachBoundedLineParser,
  type OversizedLine,
} from "../../src/boundary/bounded-line-parser.ts";
import { MAX_PROCESS_LINE_BYTES } from "../../src/boundary/process-transport.ts";

export const OVERSIZED_IMAGE_DATA = "A".repeat(6 * 1024 * 1024);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

/** Summarizes one child output event the way the process transport does past the line limit. */
export const oversizedLine = (event: Schema.Json): OversizedLine => {
  const stream = new EventEmitter();
  const summaries: OversizedLine[] = [];
  attachBoundedLineParser(stream, {
    maxLineBytes: MAX_PROCESS_LINE_BYTES,
    maxQueuedBytes: 2 * MAX_PROCESS_LINE_BYTES,
    onLine: () => {},
    onOversizedLine: (line) => summaries.push(line),
    onOverflow: () => {},
  });
  const line = `${encodeJson(event)}\n`;
  for (let offset = 0; offset < line.length; offset += 1024 * 1024)
    stream.emit("data", Buffer.from(line.slice(offset, offset + 1024 * 1024)));
  const [summary] = summaries;
  if (!summary) throw new Error("The fixture line fit within the transport limit.");
  return summary;
};
