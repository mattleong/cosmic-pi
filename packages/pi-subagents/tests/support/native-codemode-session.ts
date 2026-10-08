// Public SDK host boundary: real agent loop, nested tool hooks and native QuickJS; no inference.
import type { AuthOperationOptions, ModelType } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import { fauxCodemodeSession } from "pi-cosmic-core/testing/sdk";
import { registerSubagentErrorReceipts } from "../../src/boundary/host-tool-result.ts";
import { makeSubagentBackendRegistry, SubagentBackendRegistry } from "../../src/backend/service.ts";
import type { BackendDriver } from "../../src/backend/model.ts";
import { SubagentProfileService } from "../../src/profiles/service.ts";
import { SubagentService, type SubagentServiceContract } from "../../src/run/service.ts";
import { registerSubagentTools } from "../../src/tools/subagent.ts";
import { declaredCandidate } from "../fixtures/profiles.ts";
import { profileServiceFor } from "../tools/fixtures/tool-harness.ts";

const driver: BackendDriver = {
  host: "local",
  runtime: "claude",
  capabilities: [],
  supportsContext: (context) => context === "fresh",
  preflight: () => Effect.void,
  spawn: () => Effect.die("The session fixture delegates spawning to its owned service boundary."),
};
const registry = makeSubagentBackendRegistry([driver]);
const profilesFor = () =>
  profileServiceFor({
    profiles: {
      scout: [declaredCandidate("sonnet", { runtime: "claude" })],
      reviewer: [declaredCandidate("sonnet", { runtime: "claude" })],
      worker: [declaredCandidate("sonnet", { runtime: "claude", writeIntent: "writer" })],
      generalist: [declaredCandidate("sonnet", { runtime: "claude" })],
    },
  });

export const nativeCodemodeSession = (
  service: SubagentServiceContract,
  options: { readonly proxy?: boolean } = {},
) => {
  const profiles = profilesFor();
  return fauxCodemodeSession({
    prefix: "subagents-workflow-",
    provider: "workflow-session-test",
    // Availability stays fixture-only: a classifier authenticated by the developer's environment
    // must never be preferred, reached, or required by these tests.
    prepareModels: (models) => {
      const listAvailable = models.getAvailableOfType.bind(models);
      models.getAvailableOfType = <TType extends ModelType>(
        type: TType,
        providerId?: string,
        authOptions?: AuthOperationOptions,
      ) =>
        type === "classifier" ? Promise.resolve([]) : listAvailable(type, providerId, authOptions);
    },
    extension: {
      name: "subagents-workflow-test",
      factory: (cwd) => (pi) => {
        const receipts = registerSubagentErrorReceipts(pi);
        const owner = receipts.activate();
        pi.on("session_shutdown", () => receipts.deactivate());
        registerSubagentTools(
          pi,
          {
            environment: { cwd, projectTrusted: false },
            ...(options.proxy && {
              proxyCall: () =>
                Promise.reject(new Error("Proxy calls are model-only in this fixture.")),
            }),
            run: (effect, signal) =>
              Effect.runPromise(
                effect.pipe(
                  Effect.provideService(SubagentService, service),
                  Effect.provideService(SubagentProfileService, profiles),
                  Effect.provideService(SubagentBackendRegistry, registry),
                ),
                signal ? { signal } : undefined,
              ),
          },
          { receipts, owner },
        );
      },
    },
  });
};
