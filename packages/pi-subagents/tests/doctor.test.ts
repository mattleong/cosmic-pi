import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { extensionApiFixture, extensionContextFixture } from "pi-cosmic-core/testing";
import { runSubagentDoctor } from "../src/application/doctor.ts";
import { backendRegistryFor, SubagentBackendRegistry } from "../src/backend/service.ts";
import { subagentProfileServiceLayerFor } from "../src/profiles/service.ts";
import { InvalidSubagentRequestError } from "../src/run/errors.ts";
import { resolveTestConfig } from "./fixtures/profile-settings-inspection.ts";
import { profileLayerFor } from "./run/fixtures/service-harness.ts";
import { temporaryDirectory } from "./workspace/fixtures/repository.ts";

const claude = (model: string) => ({
  host: "local",
  runtime: "claude",
  model,
  effort: "high",
  context: "fresh",
  writeIntent: "read-only",
});

const config = {
  version: 6,
  defaultProfileSet: "doctor",
  profileSets: {
    doctor: {
      profiles: {
        scout: claude("haiku"),
        reviewer: [claude("opus"), claude("sonnet")],
        researcher: claude("haiku"),
      },
    },
  },
};

const registry = (probed: string[]) =>
  Layer.succeed(
    SubagentBackendRegistry,
    backendRegistryFor([
      {
        host: "local",
        runtime: "claude",
        capabilities: [],
        supportsContext: () => true,
        spawn: () => Effect.die("doctor never launches"),
        preflight: (request) => {
          probed.push(request.model);
          return request.model === "opus"
            ? Effect.fail(
                new InvalidSubagentRequestError({
                  code: "claude_unauthenticated",
                  message: "Claude Code is not signed in.",
                }),
              )
            : Effect.void;
        },
      },
    ]),
  );

describe("subagents doctor", () => {
  it.effect("reports each profile's route readiness, probing shared routes once", () =>
    Effect.gen(function* () {
      const agentDirectory = yield* temporaryDirectory("doctor-");
      const probed: string[] = [];
      const checks = yield* runSubagentDoctor({
        pi: extensionApiFixture(),
        ctx: extensionContextFixture(),
        agentDirectory,
        activityViewAvailable: false,
        projectTrusted: true,
      }).pipe(Effect.provide(Layer.merge(profileLayerFor(config), registry(probed))));
      const byLabel = new Map(checks.map((item) => [item.label, item]));
      expect(byLabel.get("Profile scout")?.status).toBe("ok");
      expect(byLabel.get("Profile reviewer")).toMatchObject({ status: "warning" });
      expect(byLabel.get("Profile reviewer")?.detail).toContain("claude_unauthenticated");
      expect(probed.filter((model) => model === "haiku")).toHaveLength(1);
      expect(byLabel.get("Private state")?.status).toBe("ok");
      expect(byLabel.get("Node")?.status).toBe("ok");
      expect(byLabel.get("Git")?.status).toBe("ok");
      expect(byLabel.get("Activity view")?.status).toBe("warning");
      expect(byLabel.get("Worktree verification")?.detail).toContain("none");
    }).pipe(Effect.scoped),
  );

  it.effect("reports a trusted project's worktree verification command", () =>
    Effect.gen(function* () {
      const agentDirectory = yield* temporaryDirectory("doctor-");
      const profiles = subagentProfileServiceLayerFor(
        resolveTestConfig(config, {
          version: 6,
          workspaceVerify: { command: ["pnpm", "validate"] },
        }),
      );
      const checks = yield* runSubagentDoctor({
        pi: extensionApiFixture(),
        ctx: extensionContextFixture(),
        agentDirectory,
        activityViewAvailable: true,
        projectTrusted: true,
      }).pipe(Effect.provide(Layer.merge(profiles, registry([]))));
      expect(checks.find((item) => item.label === "Worktree verification")).toMatchObject({
        status: "ok",
        detail: "pnpm validate",
      });
    }).pipe(Effect.scoped),
  );
});
