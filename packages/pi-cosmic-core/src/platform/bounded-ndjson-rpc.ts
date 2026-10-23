import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { codeUnitAt, indexOfFrom } from "../text-scan.ts";
import { isHighSurrogate, isLowSurrogate, utf8ByteLength } from "../text.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const endsInHigh = (text: string) =>
  text.length > 0 && isHighSurrogate(codeUnitAt(text, text.length - 1));

/**
 * Newline-delimited JSON RPC framing that bounds every frame, complete or still buffered, to
 * `maxBufferSize` UTF-8 bytes. An oversized or malformed frame throws, so the transport closes the
 * peer instead of buffering without limit. Each parser keeps its own partial frame.
 */
export const boundedNdjsonRpcSerialization = (
  maxBufferSize: number,
): RpcSerialization.RpcSerialization["Service"] => {
  const ndjson = RpcSerialization.makeNdjson({ maxBufferSize });
  return {
    ...ndjson,
    makeUnsafe: () => {
      const encoder = ndjson.makeUnsafe();
      let decoder: TextDecoder | undefined;
      let buffer = "";
      // While `counted`, `buffer` holds no newline and `bufferBytes` is its UTF-8 length, so a
      // chunk that completes no frame is scanned and counted alone rather than the whole frame.
      let counted = true;
      let bufferBytes = 0;
      let endsInHighSurrogate = false;
      const checkSize = (size: number) => {
        if (size <= maxBufferSize) return;
        buffer = "";
        counted = true;
        bufferBytes = 0;
        endsInHighSurrogate = false;
        throw new RpcSerialization.MaxBufferSizeExceeded({ maxBufferSize });
      };
      return {
        encode: encoder.encode,
        decode: (data) => {
          const piece = Predicate.isString(data)
            ? data
            : (decoder ??= new TextDecoder()).decode(data, { stream: true });
          const scanFrom = counted ? buffer.length : 0;
          buffer += piece;
          if (counted && indexOfFrom(piece, "\n", 0) === -1) {
            // A surrogate pair split across chunks encodes as 4 bytes, not two lone halves of 3.
            const joinsPair =
              endsInHighSurrogate && piece.length > 0 && isLowSurrogate(codeUnitAt(piece, 0));
            bufferBytes += utf8ByteLength(piece) - (joinsPair ? 2 : 0);
            if (piece.length > 0) endsInHighSurrogate = endsInHigh(piece);
            checkSize(bufferBytes);
            return [];
          }
          // A malformed frame can throw below; the next chunk then rescans the whole buffer.
          counted = false;
          const messages: Array<unknown> = [];
          let position = 0;
          let newline = indexOfFrom(buffer, "\n", scanFrom);
          while (newline !== -1) {
            const line = Fn.pipe(buffer, Str.slice(position, newline));
            checkSize(utf8ByteLength(line));
            if (line.length > 0) messages.push(decodeJson(line));
            position = newline + 1;
            newline = indexOfFrom(buffer, "\n", position);
          }
          buffer = Fn.pipe(buffer, Str.slice(position));
          bufferBytes = utf8ByteLength(buffer);
          endsInHighSurrogate = endsInHigh(buffer);
          counted = true;
          checkSize(bufferBytes);
          return messages;
        },
      };
    },
  };
};
