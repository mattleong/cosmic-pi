import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { boundaryError } from "../client/errors.ts";

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
});
export type McpGrant = typeof grantSchema.Type;
export const maximumGrantBytes = 256 * 1024;
const invalid = () =>
  boundaryError("unavailable", "not-sent", "Stored OAuth grant is invalid or unavailable.");
export const decodeGrant = (raw: string) =>
  new TextEncoder().encode(raw).length > maximumGrantBytes
    ? Effect.fail(invalid())
    : Schema.decodeEffect(Schema.fromJsonString(grantSchema))(raw, {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError(invalid),
        Effect.filterOrFail(
          (grant) =>
            Number.isFinite(grant.receivedAt) &&
            grant.receivedAt >= 0 &&
            (grant.expiresAt === undefined ||
              (Number.isFinite(grant.expiresAt) && grant.expiresAt >= grant.receivedAt)),
          invalid,
        ),
      );
export const encodeGrant = (grant: McpGrant) =>
  Schema.encodeEffect(Schema.fromJsonString(grantSchema))(grant).pipe(
    Effect.mapError(invalid),
    Effect.filterOrFail(
      (raw) => new TextEncoder().encode(raw).length <= maximumGrantBytes,
      invalid,
    ),
  );
