import * as Schema from "effect/Schema";

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
const refreshableTokens = Schema.Struct({
  refresh_token: Schema.String.check(Schema.isMinLength(1)),
});
/** Whether a stored grant can attempt refresh; the SDK boundary still validates everything else. */
export const hasRefreshToken = (grant: McpGrant): boolean =>
  Schema.is(refreshableTokens)(grant.tokens);
