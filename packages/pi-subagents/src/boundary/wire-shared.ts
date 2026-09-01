import * as Schema from "effect/Schema";

/** Shared hostile-wire JSON-line decode door for boundary stream adapters. */
export const decodeUnknownJsonOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Unknown),
);
