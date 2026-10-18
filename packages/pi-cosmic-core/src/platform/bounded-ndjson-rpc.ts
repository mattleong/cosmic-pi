import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { utf8ByteLength } from "../text.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

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
      const checkSize = (size: number) => {
        if (size <= maxBufferSize) return;
        buffer = "";
        throw new RpcSerialization.MaxBufferSizeExceeded({ maxBufferSize });
      };
      return {
        encode: encoder.encode,
        decode: (data) => {
          buffer += Predicate.isString(data)
            ? data
            : (decoder ??= new TextDecoder()).decode(data, { stream: true });
          const messages: Array<unknown> = [];
          let position = 0;
          let newline = buffer.indexOf("\n", position);
          while (newline !== -1) {
            const line = buffer.slice(position, newline);
            checkSize(utf8ByteLength(line));
            if (line.length > 0) messages.push(decodeJson(line));
            position = newline + 1;
            newline = buffer.indexOf("\n", position);
          }
          buffer = buffer.slice(position);
          checkSize(utf8ByteLength(buffer));
          return messages;
        },
      };
    },
  };
};
