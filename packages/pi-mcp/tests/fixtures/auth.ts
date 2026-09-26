import * as Effect from "effect/Effect";
import type { McpGrant, McpRegistrationReceipt } from "../../src/auth/credentials.ts";
import type { McpLoginUi } from "../../src/auth/model.ts";
import type { McpEffectiveServer, McpHttpAuth } from "../../src/config/model.ts";

export const preRegistered = {
  type: "oauth",
  registration: "pre-registered",
  clientId: "public",
  scopes: [],
} as const satisfies McpHttpAuth;

export const oauthServer = (
  identity: string,
  auth: McpHttpAuth = preRegistered,
  url = "https://resource.example/mcp",
): McpEffectiveServer => ({
  id: "owned",
  identity,
  enabled: true,
  scope: "global",
  directory: "/fixture",
  definition: { transport: "http", url, headers: {}, denyTools: [], auth },
});

/** Dynamic-client grant; callers pass the fields their assertions depend on. */
export const testGrant = (identity: string, overrides: Partial<McpGrant> = {}): McpGrant => ({
  version: 1,
  identity,
  issuer: "https://issuer.example",
  resource: "https://resource.example/mcp",
  clientId: "public",
  registration: "dynamic",
  redirectUri: "http://127.0.0.1:9000/callback",
  discovery: {},
  resourceMetadata: {},
  clientInformation: { client_id: "public" },
  tokens: { access_token: "private-access", refresh_token: "private-refresh" },
  receivedAt: 0,
  ...overrides,
});

export const testRegistration = (
  grant: McpGrant,
  overrides: Partial<McpRegistrationReceipt> = {},
): McpRegistrationReceipt => ({
  identity: grant.identity,
  issuer: grant.issuer,
  resource: grant.resource,
  registration: "dynamic",
  redirectUri: grant.redirectUri,
  clientInformation: grant.clientInformation,
  scopes: ["read"],
  ...overrides,
});

export const manualUi: McpLoginUi = {
  mode: "manual",
  openBrowser: () => Effect.void,
  readCallback: () => Effect.succeed(undefined),
};
