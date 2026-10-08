import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { SubagentBackendRegistry } from "../backend/service.ts";
import { normalizeWriteClaims } from "../domain/write-claims.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import type { WorkflowAgentAccess, WorkflowAgentSpec, WorkflowHost } from "../workflow/agent.ts";
import { WorkflowAgentCallError } from "../workflow/errors.ts";
import {
  AVAILABLE_PROFILES,
  workflowAgentProfile,
  type WorkflowAgentOptions,
} from "../workflow/options.ts";
import { resolveProfileStart, type SubagentSessionEnvironment } from "./host-profile-resolution.ts";

/**
 * Captures the starting tool call's Pi host and one profile snapshot for the whole run, like a
 * subagent_start batch. An agent resolves its route, and a fork-context profile forks from the
 * root's leaf, when the call first gets one of the run's slots; a queued call keeps that request.
 */
export const makeWorkflowHost = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  environment: SubagentSessionEnvironment,
): Effect.Effect<WorkflowHost, never, SubagentProfileService | SubagentBackendRegistry> =>
  Effect.gen(function* () {
    const profiles = yield* SubagentProfileService;
    const registry = yield* SubagentBackendRegistry;
    const snapshot = yield* profiles.capture;

    const checkAgent = Effect.fn("WorkflowHost.checkAgent")(function* (
      options: WorkflowAgentOptions,
    ): Effect.fn.Return<WorkflowAgentAccess, WorkflowAgentCallError> {
      const requested = workflowAgentProfile(options.profile);
      const definition = profiles.definition(requested);
      if (!definition)
        return yield* new WorkflowAgentCallError({
          message: `Unknown agent() profile "${requested}". ${AVAILABLE_PROFILES}`,
        });
      const claims = normalizeWriteClaims(options.writes);
      if (!claims.ok)
        return yield* new WorkflowAgentCallError({
          message: `Invalid agent() writes: ${claims.message}`,
        });
      const writerOption =
        options.writes !== undefined ? "writes" : options.isolation ? "isolation" : undefined;
      const writes = snapshot.effectiveConfig.profiles[definition.id].candidates.some(
        (candidate) => candidate.writeIntent === "writer",
      );
      if (writerOption && !writes)
        return yield* new WorkflowAgentCallError({
          message: `agent() option \`${writerOption}\` needs a writer profile such as worker; profile "${definition.id}" is read-only.`,
        });
      return writes ? "writer" : "read-only";
    });

    const resolveAgent = (spec: WorkflowAgentSpec) =>
      resolveProfileStart(pi, spec, ctx, environment, snapshot).pipe(
        // Without the captured policy, launch would fall back to default nesting limits.
        Effect.map((request) => ({
          ...request,
          nestingPolicy: snapshot.effectiveConfig.nesting,
        })),
        Effect.provideService(SubagentProfileService, profiles),
        Effect.provideService(SubagentBackendRegistry, registry),
      );

    return { checkAgent, resolveAgent } satisfies WorkflowHost;
  });
