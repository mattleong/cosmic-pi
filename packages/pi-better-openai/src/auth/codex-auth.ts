import * as Predicate from "effect/Predicate";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { decodeJwtPayloadText, readSchemaDocument } from "pi-cosmic-core";

const CodexAuthDocumentSchema = Schema.Struct({
  "openai-codex": Schema.optional(Schema.Unknown),
});
const redactedAccessToken = Schema.RedactedFromValue(Schema.Trim.check(Schema.isMinLength(1)), {
  label: "OpenAI Codex access token",
});
const CodexAuthEntrySchema = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: redactedAccessToken,
  accountId: Schema.optional(Schema.NullOr(Schema.String)),
  account_id: Schema.optional(Schema.NullOr(Schema.String)),
  expires: Schema.optional(Schema.NullOr(Schema.Number.check(Schema.isFinite()))),
});
const RegistryCredentialsSchema = Schema.Struct({
  access: Schema.optional(redactedAccessToken),
  token: Schema.optional(redactedAccessToken),
  accountId: Schema.optional(Schema.String),
  account_id: Schema.optional(Schema.String),
});
const JwtPayloadSchema = Schema.Struct({
  "https://api.openai.com/auth": Schema.optional(
    Schema.Struct({ chatgpt_account_id: Schema.optional(Schema.String) }),
  ),
});
const RegistryCredentialsFromJsonSchema = Schema.fromJsonString(RegistryCredentialsSchema);
const JwtPayloadFromJsonSchema = Schema.fromJsonString(JwtPayloadSchema);
const decodeJwtPayload = Option.liftThrowable(decodeJwtPayloadText);

export class CodexAuthError extends Schema.TaggedError<CodexAuthError>()("CodexAuthError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
export type CodexCredentials = {
  readonly accessToken: Redacted.Redacted<string>;
  readonly accountId: string;
};

const redactAccessToken = (value: string): Redacted.Redacted<string> =>
  Redacted.make(value, { label: "OpenAI Codex access token" });
export type CodexCredentialsWithSource = CodexCredentials & {
  readonly source: "modelRegistry" | "authFile";
};
export type CodexAuthResult =
  | {
      readonly _tag: "Found";
      readonly credentials: CodexCredentialsWithSource;
    }
  | { readonly _tag: "Missing" }
  | {
      readonly _tag: "Unavailable" | "Malformed";
      readonly operation: string;
      readonly message: string;
    };
const unavailable = (operation: string, message: string): CodexAuthResult => ({
  _tag: "Unavailable",
  operation,
  message,
});
const malformed = (operation: string, message: string): CodexAuthResult => ({
  _tag: "Malformed",
  operation,
  message,
});

export function extractAccountIdFromJwt(token: string): string | undefined {
  const source = Option.getOrUndefined(decodeJwtPayload(token));
  if (!source) return undefined;
  const decoded = Option.getOrUndefined(
    Schema.decodeUnknownOption(JwtPayloadFromJsonSchema)(source),
  );
  return decoded?.["https://api.openai.com/auth"]?.chatgpt_account_id?.trim() || undefined;
}
export function parseCodexRegistryCredentials(
  raw: string | undefined,
): CodexCredentials | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const parsed = Option.getOrUndefined(
    Schema.decodeUnknownOption(RegistryCredentialsFromJsonSchema)(value),
  );
  if (parsed) {
    const accessToken = parsed.access ?? parsed.token;
    const accountId = (parsed.accountId ?? parsed.account_id)?.trim();
    if (accessToken && accountId) return { accessToken, accountId };
  }
  const accountId = extractAccountIdFromJwt(value);
  return accountId ? { accessToken: redactAccessToken(value), accountId } : undefined;
}

export const readCodexAuthResult = Effect.fn("CodexAuth.readAuthResult")(function* (
  authPath: string,
) {
  const document = yield* readSchemaDocument(authPath, CodexAuthDocumentSchema).pipe(
    Effect.mapError(
      () =>
        new CodexAuthError({
          operation: "read",
          message: "Unable to read openai-codex credentials.",
        }),
    ),
  );
  const rawEntry = document?.value["openai-codex"];
  if (rawEntry === undefined) return { _tag: "Missing" } as const;
  const entry = yield* Schema.decodeUnknownEffect(CodexAuthEntrySchema)(rawEntry).pipe(
    Effect.mapError(
      () =>
        new CodexAuthError({
          operation: "decode",
          message: "OpenAI credential fields are malformed.",
        }),
    ),
    Effect.result,
  );
  if (entry._tag === "Failure") return malformed(entry.failure.operation, entry.failure.message);
  const now = yield* Clock.currentTimeMillis;
  if (Predicate.isNumber(entry.success.expires) && now >= entry.success.expires)
    return { _tag: "Missing" } as const;
  const accessToken = entry.success.access;
  const accountId = (entry.success.accountId ?? entry.success.account_id)?.trim();
  if (!accountId) return malformed("decode", "OpenAI credential fields are malformed.");
  return {
    _tag: "Found",
    credentials: {
      accessToken,
      accountId,
      source: "authFile" as const,
    },
  } as const;
});

export const getCodexCredentialsResult = Effect.fn("CodexAuth.getCredentialsResult")(function* (
  authPath: string,
  ctx: Pick<ExtensionContext, "modelRegistry">,
) {
  const [file, registryRaw] = yield* Effect.all(
    [
      readCodexAuthResult(authPath).pipe(
        Effect.catch((error) => Effect.succeed(unavailable(error.operation, error.message))),
      ),
      Effect.tryPromise({
        try: () => ctx.modelRegistry.getApiKeyForProvider("openai-codex"),
        catch: () =>
          new CodexAuthError({
            operation: "registry",
            message: "Unable to read openai-codex credentials.",
          }),
      }).pipe(Effect.result),
    ] as const,
    { concurrency: 2 },
  );
  if (registryRaw._tag === "Success") {
    const registry = parseCodexRegistryCredentials(
      Predicate.isString(registryRaw.success) ? registryRaw.success : undefined,
    );
    // Deliberate precedence: a registry API key wins over an existing auth-file OAuth
    // token (the inverse of the xAI package). Registry credentials are the
    // subscription-native path; change only with intent.
    if (registry)
      return {
        _tag: "Found",
        credentials: { ...registry, source: "modelRegistry" as const },
      } as const;
    if (file._tag === "Found") return file;
    if (registryRaw.success)
      return malformed("registry-decode", "OpenAI registry credentials are malformed.");
  } else if (file._tag === "Found") return file;
  if (file._tag !== "Missing") return file;
  if (registryRaw._tag === "Failure")
    return unavailable(registryRaw.failure.operation, registryRaw.failure.message);
  return { _tag: "Missing" } as const;
});

export const getCodexCredentials = Effect.fn("CodexAuth.getCredentials")(function* (
  authPath: string,
  ctx: Pick<ExtensionContext, "modelRegistry">,
) {
  const result = yield* getCodexCredentialsResult(authPath, ctx);
  if (result._tag === "Found") return result.credentials;
  if (result._tag === "Missing") return undefined;
  return yield* new CodexAuthError({ operation: result.operation, message: result.message });
});
