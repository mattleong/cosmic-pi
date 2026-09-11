import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { boundaryError } from "../client/errors.ts";

export const registrationReceiptSchema = Schema.Struct({
  identity: Schema.String,
  issuer: Schema.String,
  resource: Schema.String,
  registration: Schema.Literal("dynamic"),
  redirectUri: Schema.String,
  clientInformation: Schema.Json,
  scopes: Schema.Array(Schema.String),
});
export type McpRegistrationReceipt = typeof registrationReceiptSchema.Type;

/** SDK discovery/client payloads stay opaque until decoded again by the SDK boundary. */
export const grantSchema = Schema.Struct({
  version: Schema.Literal(1),
  identity: Schema.String,
  issuer: Schema.String,
  resource: Schema.String,
  clientId: Schema.String,
  registration: Schema.Literals(["pre-registered", "dynamic", "metadata"]),
  redirectUri: Schema.String,
  discovery: Schema.Json,
  resourceMetadata: Schema.Json,
  resourceMetadataSource: Schema.optionalKey(Schema.Literals(["configured", "origin"])),
  clientInformation: Schema.Json,
  tokens: Schema.Json,
  receivedAt: Schema.Finite,
  expiresAt: Schema.optional(Schema.Finite),
  quarantine: Schema.optionalKey(Schema.Literal("refresh")),
  requestedScopes: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type McpGrant = typeof grantSchema.Type;
export const maximumGrantBytes = 256 * 1024;
export const validGrantTimes = (grant: McpGrant) =>
  Number.isFinite(grant.receivedAt) &&
  grant.receivedAt >= 0 &&
  (grant.expiresAt === undefined ||
    (Number.isFinite(grant.expiresAt) && grant.expiresAt >= grant.receivedAt));
const invalid = () =>
  boundaryError("unavailable", "not-sent", "Stored OAuth grant is invalid or unavailable.");
export const decodeGrant = (raw: string) =>
  new TextEncoder().encode(raw).length > maximumGrantBytes
    ? Effect.fail(invalid())
    : Schema.decodeEffect(Schema.fromJsonString(grantSchema))(raw, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(invalid), Effect.filterOrFail(validGrantTimes, invalid));
export const encodeGrant = (grant: McpGrant) =>
  Schema.encodeEffect(Schema.fromJsonString(grantSchema))(grant).pipe(
    Effect.mapError(invalid),
    Effect.filterOrFail(
      (raw) => new TextEncoder().encode(raw).length <= maximumGrantBytes,
      invalid,
    ),
  );
