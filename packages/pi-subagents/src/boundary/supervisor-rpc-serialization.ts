/**
 * Private RPC requires malformed frames to close the peer, not disappear. Effect's NDJSON
 * decoder skips malformed lines, so keep its codec/encoder but own bounded, strict decoding.
 */
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export const makeSupervisorRpcSerialization = (
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
            checkSize(newline - position);
            const line = buffer.slice(position, newline);
            if (line.length > 0) messages.push(decodeJson(line));
            position = newline + 1;
            newline = buffer.indexOf("\n", position);
          }
          buffer = buffer.slice(position);
          checkSize(buffer.length);
          return messages;
        },
      };
    },
  };
};
