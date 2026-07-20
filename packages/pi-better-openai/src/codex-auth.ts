import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { JsonDocumentStore } from "pi-cosmic-core";

const CodexAuthEntrySchema = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: Schema.String,
  accountId: Schema.optional(Schema.NullOr(Schema.String)),
  account_id: Schema.optional(Schema.NullOr(Schema.String)),
  expires: Schema.optional(Schema.NullOr(Schema.Number)),
});
const RegistryCredentialsSchema = Schema.Struct({
  access: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String),
  account_id: Schema.optional(Schema.String),
});
const JwtPayloadSchema = Schema.Struct({
  "https://api.openai.com/auth": Schema.optional(
    Schema.Struct({ chatgpt_account_id: Schema.optional(Schema.String) }),
  ),
});

export class CodexAuthError extends Schema.TaggedErrorClass<CodexAuthError>()("CodexAuthError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export type CodexCredentials = { readonly accessToken: string; readonly accountId: string };
export type CodexCredentialsWithSource = CodexCredentials & {
  readonly source: "modelRegistry" | "authFile";
};

const decodeBase64Url = (value: string) =>
  Effect.try({
    try: () => {
      const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
      return Buffer.from(padded, "base64").toString("utf8");
    },
    catch: () =>
      new CodexAuthError({ operation: "jwt", message: "Unable to decode Codex token metadata." }),
  });

export const extractAccountIdFromJwt = Effect.fn("CodexAuth.extractAccountIdFromJwt")(function* (
  token: string,
) {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  const source = yield* decodeBase64Url(payload).pipe(Effect.catch(() => Effect.succeed("")));
  if (!source) return undefined;
  const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JwtPayloadSchema))(
    source,
  ).pipe(Effect.catch(() => Effect.void));
  const accountId = decoded?.["https://api.openai.com/auth"]?.chatgpt_account_id?.trim();
  return accountId || undefined;
});

export const parseCodexRegistryCredentials = Effect.fn("CodexAuth.parseRegistryCredentials")(
  function* (raw: string | undefined) {
    const value = raw?.trim();
    if (!value) return undefined;
    const parsed = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(RegistryCredentialsSchema),
    )(value).pipe(Effect.catch(() => Effect.void));
    if (parsed) {
      const accessToken = (parsed.access ?? parsed.token)?.trim();
      const accountId = (parsed.accountId ?? parsed.account_id)?.trim();
      if (accessToken && accountId) return { accessToken, accountId } satisfies CodexCredentials;
    }
    const accountId = yield* extractAccountIdFromJwt(value);
    return accountId ? ({ accessToken: value, accountId } satisfies CodexCredentials) : undefined;
  },
);

export const readCodexAuth = Effect.fn("CodexAuth.readAuth")(function* (authPath: string) {
  const documents = yield* JsonDocumentStore;
  const document = yield* documents.readObject(authPath).pipe(Effect.catch(() => Effect.void));
  const entry = yield* Schema.decodeUnknownEffect(CodexAuthEntrySchema)(
    document?.["openai-codex"],
  ).pipe(Effect.catch(() => Effect.void));
  if (!entry) return undefined;
  const now = yield* Clock.currentTimeMillis;
  if (typeof entry.expires === "number" && now >= entry.expires) return undefined;
  const accessToken = entry.access.trim();
  const accountId = (entry.accountId ?? entry.account_id)?.trim();
  return accessToken && accountId
    ? ({ accessToken, accountId } satisfies CodexCredentials)
    : undefined;
});

export const getCodexCredentials = Effect.fn("CodexAuth.getCredentials")(function* (
  authPath: string,
  ctx: Pick<ExtensionContext, "modelRegistry">,
) {
  const registryToken = yield* Effect.tryPromise({
    try: () => ctx.modelRegistry.getApiKeyForProvider("openai-codex"),
    catch: () =>
      new CodexAuthError({
        operation: "registry",
        message: "Unable to read openai-codex credentials.",
      }),
  }).pipe(Effect.catch(() => Effect.void));
  const registry = yield* parseCodexRegistryCredentials(
    typeof registryToken === "string" ? registryToken : undefined,
  );
  if (registry) return { ...registry, source: "modelRegistry" as const };
  const auth = yield* readCodexAuth(authPath);
  return auth ? { ...auth, source: "authFile" as const } : undefined;
});
