import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { oauthScopes } from "../auth/scopes.ts";
import { boundaryError } from "../client/errors.ts";

export interface BearerChallenge {
  readonly resourceMetadata?: string | undefined;
  readonly scope?: string | undefined;
  readonly error?: string | undefined;
}
export const invalidChallenge = () =>
  boundaryError(
    "unavailable",
    "not-sent",
    "OAuth protected-resource challenge was invalid.",
    "oauth-resource-metadata-invalid",
  );
const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const parameterStart = new RegExp(`^${token}[ \\t]*=`);
const schemeStart = new RegExp(`^(${token})(?:[ \\t]+(.*))?$`);
const parameterValue = new RegExp(
  `^(${token})[ \\t]*=[ \\t]*(?:"((?:\\\\.|[^"\\\\])*)"|(${token}))[ \\t]*$`,
);

/** One bounded, unambiguous Bearer challenge. Never combine fields from separate challenges. */
export const parseBearerChallenge = (header: string) =>
  Effect.try({
    try: (): BearerChallenge | undefined => {
      if (header.length > 8192 || /[^\x20-\x7e\t]/.test(header)) throw invalidChallenge();
      if (header.trim() === "") return undefined;
      const parts: string[] = [];
      let start = 0;
      let quoted = false;
      let escaped = false;
      for (let index = 0; index < header.length; index++) {
        const character = header[index];
        if (escaped) escaped = false;
        else if (quoted && character === "\\") escaped = true;
        else if (character === '"') quoted = !quoted;
        else if (!quoted && character === ",") {
          parts.push(header.slice(start, index).trim());
          start = index + 1;
        }
      }
      if (quoted || escaped) throw invalidChallenge();
      parts.push(header.slice(start).trim());
      let scheme: string | undefined;
      let bearer: Map<string, string> | undefined;
      for (const part of parts) {
        if (!part) throw invalidChallenge();
        let parameter = part;
        if (!parameterStart.test(part)) {
          const match = schemeStart.exec(part);
          if (!match) throw invalidChallenge();
          scheme = match[1]!.toLowerCase();
          parameter = match[2] ?? "";
          if (scheme === "bearer") {
            if (bearer) throw invalidChallenge();
            bearer = new Map();
          }
        }
        if (!scheme) throw invalidChallenge();
        if (scheme !== "bearer" || !parameter) continue;
        const match = parameterValue.exec(parameter);
        if (!match) throw invalidChallenge();
        const name = match[1]!.toLowerCase();
        const value = match[2]?.replace(/\\(.)/g, "$1") ?? match[3]!;
        if (bearer!.has(name)) throw invalidChallenge();
        bearer!.set(name, value);
      }
      if (!bearer) return undefined;
      const resourceMetadata = bearer.get("resource_metadata");
      const scope = bearer.get("scope");
      const error = bearer.get("error");
      if (
        resourceMetadata === "" ||
        error === "" ||
        (scope !== undefined && (!scope || !Schema.is(oauthScopes)(scope.split(" "))))
      )
        throw invalidChallenge();
      return { resourceMetadata, scope, error };
    },
    catch: invalidChallenge,
  });
