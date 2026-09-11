import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { boundaryError } from "../client/errors.ts";
import {
  grantSchema,
  maximumGrantBytes,
  registrationReceiptSchema,
  validGrantTimes,
} from "./credentials.ts";

const credentialRecordSchema = Schema.Struct({
  version: Schema.Literal(2),
  grant: Schema.optionalKey(grantSchema),
  registration: Schema.optionalKey(registrationReceiptSchema),
});
export type McpCredentialRecord = typeof credentialRecordSchema.Type;
const storedSchema = Schema.Union([credentialRecordSchema, grantSchema]);
const invalid = () =>
  boundaryError("unavailable", "not-sent", "Stored OAuth credentials are invalid or unavailable.");
const bounded = (raw: string) => new TextEncoder().encode(raw).length <= maximumGrantBytes;
const valid = (record: McpCredentialRecord) =>
  record.grant === undefined || validGrantTimes(record.grant);

/** The v2 envelope uses the existing v1 Keychain service and account. */
export const decodeCredentialRecord = (raw: string) =>
  bounded(raw)
    ? Schema.decodeEffect(Schema.fromJsonString(storedSchema))(raw, {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError(invalid),
        Effect.map(
          (record): McpCredentialRecord =>
            record.version === 1 ? { version: 2, grant: record } : record,
        ),
        Effect.filterOrFail(valid, invalid),
      )
    : Effect.fail(invalid());
export const encodeCredentialRecord = (record: McpCredentialRecord) =>
  valid(record)
    ? Schema.encodeEffect(Schema.fromJsonString(credentialRecordSchema))(record).pipe(
        Effect.mapError(invalid),
        Effect.filterOrFail(bounded, invalid),
      )
    : Effect.fail(invalid());
