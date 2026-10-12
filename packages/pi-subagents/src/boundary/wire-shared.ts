import * as Schema from "effect/Schema";

export const decodeUnknownJsonOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Json),
);
