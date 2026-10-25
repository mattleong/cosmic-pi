import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { nodeFilePlatformLayer, SafeFile } from "pi-cosmic-core";
import { extensionApiFixture, extensionContextFixture, modelFixture } from "pi-cosmic-core/testing";
import { runSubagentDoctor } from "../src/application/doctor.ts";
import { backendRegistryFor, SubagentBackendRegistry } from "../src/backend/service.ts";
import { subagentProfileServiceLayerFor } from "../src/profiles/service.ts";
import { InvalidSubagentRequestError } from "../src/run/errors.ts";
import { resolveTestConfig } from "./fixtures/profile-settings-inspection.ts";
import { profileLayerFor } from "./run/fixtures/service-harness.ts";
import { git } from "../src/boundary/git-worktree-process.ts";
import { nodePath as path } from "./support/node-builtins.ts";
import { temporaryDirectory, writeFile } from "./workspace/fixtures/repository.ts";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

const MODEL_IDS = ["haiku", "opus", "sonnet", "fable", "mythos", "spark"];
const testModels = Arr.map(MODEL_IDS, (id) =>
  modelFixture({ provider: "test", id, reasoning: true }),
);
const doctorContext = (overrides: Parameters<typeof extensionContextFixture>[0] = {}) =>
  extensionContextFixture({ modelRegistry: { getAvailable: () => testModels }, ...overrides });

const pi = (model: string) => ({
  model: `test/${model}`,
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
        scout: pi("haiku"),
        reviewer: [pi("opus"), pi("sonnet")],
        researcher: pi("haiku"),
      },
    },
  },
};

const doctor = (input: Parameters<typeof runSubagentDoctor>[0]) =>
  runSubagentDoctor(input).pipe(
    Effect.provide(SafeFile.layer.pipe(Layer.provideMerge(nodeFilePlatformLayer))),
  );

const registry = (probed: string[]) =>
  Layer.succeed(
    SubagentBackendRegistry,
    backendRegistryFor({
      capabilities: [],
      supportsContext: () => true,
      spawn: () => Effect.die("doctor never launches"),
      preflight: (request) => {
        probed.push(request.model);
        return request.model === "test/opus"
          ? Effect.fail(
              InvalidSubagentRequestError.make({
                code: "provider_unauthenticated",
                message: "The provider is not signed in.",
              }),
            )
          : Effect.void;
      },
    }),
  );

describe("subagents doctor", () => {
  it.effect("reports each profile's route readiness, probing shared routes once", () =>
    Effect.gen(function* () {
      const agentDirectory = yield* temporaryDirectory("doctor-");
      const probed: string[] = [];
      const checks = yield* doctor({
        pi: extensionApiFixture(),
        ctx: doctorContext(),
        agentDirectory,
        activityViewAvailable: false,
        projectTrusted: true,
      }).pipe(Effect.provide(Layer.merge(profileLayerFor(config), registry(probed))));
      const byLabel = new Map(Arr.map(checks, (item) => [item.label, item]));
      expect(byLabel.get("Profile scout")?.status).toBe("ok");
      expect(byLabel.get("Profile reviewer")).toMatchObject({ status: "warning" });
      expect(byLabel.get("Profile reviewer")?.detail).toContain("provider_unauthenticated");
      expect(Arr.filter(probed, (model) => model === "test/haiku")).toHaveLength(1);
      expect(byLabel.get("Private state")?.status).toBe("ok");
      expect(byLabel.get("Node")?.status).toBe("ok");
      expect(byLabel.get("Git")?.status).toBe("ok");
      expect(byLabel.get("Activity view")?.status).toBe("warning");
      expect(byLabel.get("WorktreeCreate hooks")?.detail).toBe("none");
      expect(byLabel.get("WorktreeRemove hooks")?.detail).toBe("none");
    }).pipe(Effect.scoped),
  );

  it.effect("probes distinct routes concurrently, at most four at a time", () =>
    Effect.gen(function* () {
      const agentDirectory = yield* temporaryDirectory("doctor-");
      // Each probe reports its admission, then holds its slot until the test releases one, so
      // admissions, not scheduling, show the bound.
      const admitted = yield* Queue.unbounded<void>();
      const releases = yield* Queue.unbounded<void>();
      let active = 0;
      let peak = 0;
      const probing = Layer.succeed(
        SubagentBackendRegistry,
        backendRegistryFor({
          capabilities: [],
          supportsContext: () => true,
          spawn: () => Effect.die("doctor never launches"),
          preflight: () =>
            Effect.gen(function* () {
              active += 1;
              peak = Math.max(peak, active);
              yield* Queue.offer(admitted, undefined);
              yield* Queue.take(releases);
              active -= 1;
            }),
        }),
      );
      const routes = MODEL_IDS;
      const running = yield* doctor({
        pi: extensionApiFixture(),
        ctx: doctorContext(),
        agentDirectory,
        activityViewAvailable: undefined,
        projectTrusted: true,
      }).pipe(
        Effect.provide(
          Layer.merge(
            profileLayerFor({
              ...config,
              profileSets: {
                doctor: {
                  profiles: {
                    scout: pi(routes[0]!),
                    reviewer: pi(routes[1]!),
                    researcher: pi(routes[2]!),
                    planner: pi(routes[3]!),
                    worker: pi(routes[4]!),
                    oracle: pi(routes[5]!),
                  },
                },
              },
            }),
            probing,
          ),
        ),
        Effect.forkChild,
      );
      for (let probe = 0; probe < 4; probe++) yield* Queue.take(admitted);
      expect(active).toBe(4);
      // Every later probe waits for a held slot to be released.
      for (let probe = 4; probe < routes.length; probe++) {
        yield* Queue.offer(releases, undefined);
        yield* Queue.take(admitted);
        expect(active).toBe(4);
      }
      yield* Queue.offerAll(
        releases,
        Array.from({ length: 4 }, () => undefined),
      );
      yield* Fiber.join(running);
      expect(active).toBe(0);
      expect(peak).toBe(4);
    }).pipe(Effect.scoped),
  );

  it.effect("lists configured worktree hooks per event and scope", () =>
    Effect.gen(function* () {
      const agentDirectory = yield* temporaryDirectory("doctor-");
      const profiles = subagentProfileServiceLayerFor(
        resolveTestConfig(
          { ...config, hooks: { WorktreeCreate: [{ command: ["pnpm", "install"] }] } },
          {
            version: 6,
            hooks: {
              WorktreeCreate: [{ command: ["./copy-env"] }],
              WorktreeRemove: [{ command: ["./prune"] }],
            },
          },
        ),
      );
      const checks = yield* doctor({
        pi: extensionApiFixture(),
        ctx: doctorContext(),
        agentDirectory,
        activityViewAvailable: true,
        projectTrusted: true,
      }).pipe(Effect.provide(Layer.merge(profiles, registry([]))));
      const create =
        Option.getOrUndefined(
          Arr.findFirst(checks, (item) => item.label === "WorktreeCreate hooks"),
        )?.detail ?? "";
      expect(Option.getOrElse(Fn.pipe(create, Str.indexOf("pnpm install")), () => -1)).toBeLessThan(
        Option.getOrElse(Fn.pipe(create, Str.indexOf("./copy-env")), () => -1),
      );
      expect(create).toContain("global");
      expect(create).toContain("project");
      expect(
        Option.getOrUndefined(
          Arr.findFirst(checks, (item) => item.label === "WorktreeRemove hooks"),
        )?.detail,
      ).toContain("./prune");
    }).pipe(Effect.scoped),
  );
  it.effect("lists the checkout's .worktreeinclude patterns", () =>
    Effect.gen(function* () {
      const agentDirectory = yield* temporaryDirectory("doctor-");
      const checkout = yield* temporaryDirectory("doctor-checkout-");
      yield* git(checkout, ["init", "--template="]);
      yield* writeFile(path.join(checkout, ".worktreeinclude"), "# local\n.env\nconfig/*.local\n");
      const checks = yield* doctor({
        pi: extensionApiFixture(),
        ctx: doctorContext({ cwd: checkout }),
        agentDirectory,
        activityViewAvailable: true,
        projectTrusted: false,
      }).pipe(Effect.provide(Layer.merge(profileLayerFor(config), registry([]))));
      const included = Option.getOrUndefined(
        Arr.findFirst(checks, (item) => item.label === ".worktreeinclude"),
      );
      expect(included?.status).toBe("ok");
      expect(included?.detail).toContain(".env");
      expect(included?.detail).toContain("config/*.local");
      expect(included?.detail).not.toContain("#");
    }).pipe(Effect.scoped),
  );
  it.effect("checks each custom agent's route and reports invalid agents", () =>
    Effect.gen(function* () {
      const agentDirectory = yield* temporaryDirectory("doctor-");
      const probed: string[] = [];
      const checks = yield* doctor({
        pi: extensionApiFixture(),
        ctx: doctorContext(),
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
      const byLabel = new Map(Arr.map(checks, (item) => [item.label, item]));
      expect(byLabel.get("Agent fast-review")?.status).toBe("ok");
      expect(byLabel.get("Agent strict-review")?.status).toBe("warning");
      expect(byLabel.get("Agent broken")?.status).toBe("failed");
      // Agents share routes with their profiles, which are probed once.
      expect(Arr.filter(probed, (model) => model === "test/haiku")).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});
