import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { SubagentBackendRegistry } from "../backend/service.ts";
import { normalizeWriteClaims } from "../domain/write-claims.ts";
import { PROFILE_IDS } from "../profiles/model.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import {
  WorkflowAgentCallError,
  type WorkflowAgentSpec,
  type WorkflowHost,
} from "../workflow/agent.ts";
import { resolveProfileStart, type SubagentSessionEnvironment } from "./host-profile-resolution.ts";

const DEFAULT_PROFILE = "generalist";

/**
 * Captures the starting tool call's Pi host and one profile snapshot for the whole run, like a
 * subagent_start batch. An agent resolves its route, and a fork-context profile forks from the
 * root's leaf, when the call first gets a concurrency slot; a queued call keeps that request.
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

    const checkAgent = (spec: WorkflowAgentSpec) =>
      Effect.suspend(() => {
        const requested = spec.profile?.trim() || DEFAULT_PROFILE;
        const definition = profiles.definition(requested);
        if (!definition)
          return Effect.fail(
            new WorkflowAgentCallError({
              message: `Unknown agent() profile "${requested}". Configured profiles: ${PROFILE_IDS.join(", ")}.`,
            }),
          );
        const claims = normalizeWriteClaims(spec.writes);
        if (!claims.ok)
          return Effect.fail(
            new WorkflowAgentCallError({ message: `Invalid agent() writes: ${claims.message}` }),
          );
        const writerOption =
          spec.writes !== undefined ? "writes" : spec.isolation ? "isolation" : undefined;
        const writes = snapshot.effectiveConfig.profiles[definition.id].candidates.some(
          (candidate) => candidate.writeIntent === "writer",
        );
        return writerOption && !writes
          ? Effect.fail(
              new WorkflowAgentCallError({
                message: `agent() option \`${writerOption}\` needs a writer profile such as worker; profile "${definition.id}" is read-only.`,
              }),
            )
          : Effect.void;
      });

    const resolveAgent = (spec: WorkflowAgentSpec) =>
      resolveProfileStart(
        pi,
        { task: spec.task, name: spec.name, profile: spec.profile, writes: spec.writes },
        ctx,
        environment,
        snapshot,
      ).pipe(
        // Without the captured policy, launch would fall back to default nesting limits.
        Effect.map((request) => ({
          ...request,
          nestingPolicy: snapshot.effectiveConfig.nesting,
          nestingPolicyRevision: snapshot.revision,
        })),
        Effect.provideService(SubagentProfileService, profiles),
        Effect.provideService(SubagentBackendRegistry, registry),
      );

    return { checkAgent, resolveAgent } satisfies WorkflowHost;
  });
