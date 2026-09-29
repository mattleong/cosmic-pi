import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { boundaryError } from "../client/errors.ts";
import type { McpOAuthConfig } from "../config/model.ts";
import type { McpLoginUi, McpScopeProposal } from "./model.ts";

/** RFC 6749 scope-token is case-sensitive printable ASCII, except quote and backslash. */
export const oauthScopeToken = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[\x21\x23-\x5b\x5d-\x7e]+$/),
);
export const oauthScopes = Schema.Array(oauthScopeToken).check(
  Schema.isMaxLength(512),
  Schema.makeFilter((values) => values.join(" ").length <= 8192),
);
export const invalidScopes = () =>
  boundaryError("denied", "not-sent", "OAuth permissions were invalid.", "oauth-scope-invalid");
export const validateScopes = (values: ReadonlyArray<string>) =>
  Schema.decodeEffect(oauthScopes)(values).pipe(
    Effect.map((accepted) => [...new Set(accepted)].sort()),
    Effect.mapError(invalidScopes),
  );
/** No trim, case folding, or whitespace repair at OAuth boundaries. */
export const parseScopes = (value: string) => validateScopes(value === "" ? [] : value.split(" "));

export interface ScopeEvidence {
  readonly challenge?:
    | { readonly scope?: string | undefined; readonly error?: string | undefined }
    | undefined;
  readonly retained: boolean;
  /** Scopes of the grant being stepped up; the user already approved them. */
  readonly previousScopes?: ReadonlyArray<string> | undefined;
  readonly resourceScopes?: ReadonlyArray<string> | undefined;
  readonly serverScopes?: ReadonlyArray<string> | undefined;
  readonly grantTypes?: ReadonlyArray<string> | undefined;
}
export const proposeScopes = (config: McpOAuthConfig, evidence: ScopeEvidence) =>
  Effect.gen(function* () {
    const configured = yield* validateScopes(config.scopes);
    const challenge =
      evidence.challenge?.scope === undefined
        ? undefined
        : yield* parseScopes(evidence.challenge.scope);
    const resource =
      evidence.resourceScopes === undefined
        ? undefined
        : yield* validateScopes(evidence.resourceScopes);
    const advertised =
      evidence.serverScopes === undefined
        ? []
        : // Discovery already bounds the metadata body. The AS catalog can cover other APIs;
          // validate its tokens without imposing the much smaller outbound request budget.
          yield* Schema.decodeEffect(Schema.Array(oauthScopeToken))(evidence.serverScopes).pipe(
            Effect.mapError(invalidScopes),
          );
    const stepUp =
      evidence.retained && evidence.challenge?.error === "insufficient_scope" && challenge
        ? challenge
        : undefined;
    // Step-up keeps what the rejected grant already held, so fixing one operation's
    // permissions never removes another's.
    const previous = stepUp
      ? yield* validateScopes(evidence.previousScopes ?? []).pipe(Effect.orElseSucceed(() => []))
      : [];
    let requested = configured;
    let source: McpScopeProposal["source"] = "configured";
    if (!config.explicitEmptyScopes) {
      if (stepUp) {
        requested = [...new Set([...configured, ...previous, ...stepUp])].sort();
        source = "challenge";
      } else if (configured.length === 0) {
        requested = challenge ?? resource ?? [];
        source = challenge !== undefined ? "challenge" : "resource-metadata";
      }
      if (
        requested.length > 0 &&
        advertised.includes("offline_access") &&
        (!evidence.grantTypes || evidence.grantTypes.includes("refresh_token"))
      )
        requested = [...new Set([...requested, "offline_access"])].sort();
    }
    requested = yield* validateScopes(requested);
    return Object.freeze({
      requested: Object.freeze(requested),
      additions: Object.freeze(
        requested.filter((scope) => !configured.includes(scope) && !previous.includes(scope)),
      ),
      source,
    }) satisfies McpScopeProposal;
  });

export const approveScopes = (ui: McpLoginUi, proposal: McpScopeProposal, deadline: number) =>
  Effect.gen(function* () {
    if (proposal.additions.length === 0) return proposal.requested;
    if (!ui.approveScopes)
      return yield* boundaryError(
        "denied",
        "not-sent",
        "OAuth permissions require explicit user approval.",
        "oauth-scope-approval-required",
      );
    const now = yield* Clock.currentTimeMillis;
    if (now >= deadline)
      return yield* boundaryError("timeout", "not-sent", "OAuth approval expired.");
    const approved = yield* ui.approveScopes(proposal, deadline).pipe(
      Effect.timeoutOrElse({
        duration: deadline - now,
        orElse: () => Effect.fail(boundaryError("timeout", "not-sent", "OAuth approval expired.")),
      }),
    );
    if ((yield* Clock.currentTimeMillis) >= deadline)
      return yield* boundaryError("timeout", "not-sent", "OAuth approval expired.");
    if (!approved)
      return yield* boundaryError("cancelled", "not-sent", "OAuth login was cancelled.");
    return proposal.requested;
  });

/** The SDK must not retain an endpoint's own scope or duplicate scope parameters. */
export const validateAuthorizationScopes = (url: URL, approved: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const values = url.searchParams.getAll("scope");
    if (approved.length === 0) {
      if (values.length !== 0) return yield* invalidScopes();
      return;
    }
    if (values.length !== 1) return yield* invalidScopes();
    const actual = yield* parseScopes(values[0]!);
    if (actual.length !== approved.length || actual.some((scope) => !approved.includes(scope)))
      return yield* invalidScopes();
  });
