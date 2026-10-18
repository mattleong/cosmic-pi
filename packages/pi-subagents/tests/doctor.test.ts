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
import { nodeFsPromises as fs, nodePath as path } from "../src/boundary/node-builtins.ts";

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
      expect(byLabel.has("Legacy workspaces")).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "warns while an earlier version's workspace registry exists, naming recovery commands",
    () =>
      Effect.gen(function* () {
        const agentDirectory = yield* temporaryDirectory("doctor-");
        const legacy = path.join(agentDirectory, "git-workspaces");
        yield* Effect.promise(() =>
          fs.mkdir(path.join(legacy, "ws-a", "worker"), { recursive: true }),
        );
        const checks = yield* runSubagentDoctor({
          pi: extensionApiFixture(),
          ctx: extensionContextFixture(),
          agentDirectory,
          activityViewAvailable: true,
          projectTrusted: true,
        }).pipe(Effect.provide(Layer.merge(profileLayerFor(config), registry([]))));
        const warning = checks.find((item) => item.label === "Legacy workspaces");
        expect(warning?.status).toBe("warning");
        expect(warning?.detail).toContain(`git -C '${path.join(legacy, "ws-a", "worker")}' diff`);
        expect(warning?.detail).toContain(`rm -rf '${legacy}'`);
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
  it.effect("lists a trusted project's workspaceInclude patterns", () =>
    Effect.gen(function* () {
      const agentDirectory = yield* temporaryDirectory("doctor-");
      const profiles = subagentProfileServiceLayerFor(
        resolveTestConfig(config, { version: 6, workspaceInclude: [".env", "config/*.local"] }),
      );
      const checks = yield* runSubagentDoctor({
        pi: extensionApiFixture(),
        ctx: extensionContextFixture(),
        agentDirectory,
        activityViewAvailable: true,
        projectTrusted: true,
      }).pipe(Effect.provide(Layer.merge(profiles, registry([]))));
      const included = checks.find((item) => item.label === "Worktree included files");
      expect(included?.status).toBe("ok");
      expect(included?.detail).toContain(".env");
      expect(included?.detail).toContain("config/*.local");
    }).pipe(Effect.scoped),
  );
  it.effect("checks each custom agent's route and reports invalid agents", () =>
    Effect.gen(function* () {
      const agentDirectory = yield* temporaryDirectory("doctor-");
      const probed: string[] = [];
      const checks = yield* runSubagentDoctor({
        pi: extensionApiFixture(),
        ctx: extensionContextFixture(),
        agentDirectory,
        activityViewAvailable: undefined,
        projectTrusted: true,
      }).pipe(
        Effect.provide(
          Layer.merge(
            profileLayerFor({
              ...config,
              agents: {
                "fast-review": {
                  description: "Reviews quickly.",
                  instructions: "Review the diff.",
                  profile: "scout",
                },
                "strict-review": {
                  description: "Reviews strictly.",
                  instructions: "Review everything.",
                  profile: "reviewer",
                },
                broken: { description: "Missing instructions." },
              },
            }),
            registry(probed),
          ),
        ),
      );
      const byLabel = new Map(checks.map((item) => [item.label, item]));
      expect(byLabel.get("Agent fast-review")?.status).toBe("ok");
      expect(byLabel.get("Agent strict-review")?.status).toBe("warning");
      expect(byLabel.get("Agent broken")?.status).toBe("failed");
      // Agents share routes with their profiles, which are probed once.
      expect(probed.filter((model) => model === "haiku")).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});
