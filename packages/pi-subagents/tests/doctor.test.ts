import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { nodeFilePlatformLayer, SafeFile } from "pi-cosmic-core";
import { extensionApiFixture, extensionContextFixture, modelFixture } from "pi-cosmic-core/testing";
import { runSubagentDoctor } from "../src/application/doctor.ts";
import { SubagentBackendRegistry } from "../src/backend/service.ts";
import { subagentProfileServiceLayerFor } from "../src/profiles/service.ts";
import { InvalidSubagentRequestError } from "../src/run/errors.ts";
import { resolveTestConfig } from "./fixtures/profile-settings-inspection.ts";
import { profileLayerFor } from "./run/fixtures/service-harness.ts";
import { git } from "../src/boundary/git-worktree-process.ts";
import { nodeExecutableProblem } from "../src/boundary/node-executable.ts";
import { nodePath as path } from "./support/node-builtins.ts";
import { nodeDisplayHomeDirectory } from "pi-cosmic-core/platform/node-builtins";
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

const registry = (probed: string[] = []) =>
  Layer.succeed(SubagentBackendRegistry, {
    spawn: () => Effect.die("doctor never launches"),
    preflight: (model) => {
      probed.push(model);
      return model === "test/opus"
        ? Effect.fail(
            InvalidSubagentRequestError.make({
              code: "provider_unauthenticated",
              message: "The provider is not signed in.",
            }),
          )
        : Effect.void;
    },
  });

/** The doctor's checks by label, over the default configuration unless a test names its own. */
const checksByLabel = (
  options: {
    readonly profiles?: ReturnType<typeof subagentProfileServiceLayerFor>;
    readonly registry?: Layer.Layer<SubagentBackendRegistry>;
    readonly input?: Partial<Parameters<typeof runSubagentDoctor>[0]>;
  } = {},
) =>
  Effect.gen(function* () {
    const agentDirectory = yield* temporaryDirectory("doctor-");
    const checks = yield* doctor({
      pi: extensionApiFixture(),
      ctx: doctorContext(),
      agentDirectory,
      activityViewAvailable: false,
      projectTrusted: true,
      ...options.input,
    }).pipe(
      Effect.provide(
        Layer.merge(options.profiles ?? profileLayerFor(config), options.registry ?? registry()),
      ),
    );
    return new Map(Arr.map(checks, (item) => [item.label, item]));
  });

describe("subagents doctor", () => {
  it.effect("reports each profile's route readiness, probing shared routes once", () =>
    Effect.gen(function* () {
      const probed: string[] = [];
      const byLabel = yield* checksByLabel({ registry: registry(probed) });
      expect(byLabel.get("Profile scout")?.status).toBe("ok");
      expect(byLabel.get("Profile reviewer")).toMatchObject({ status: "warning" });
      // The panel reads as a person would: the cause in words, without its internal code.
      expect(byLabel.get("Profile reviewer")?.detail).toBe(
        "test/opus: The provider is not signed in; a fallback will be tried",
      );
      expect(Arr.filter(probed, (model) => model === "test/haiku")).toHaveLength(1);
      expect(byLabel.get("Private state")?.status).toBe("ok");
      expect(byLabel.get("Node")?.status).toBe("ok");
      expect(byLabel.get("Git")?.status).toBe("ok");
      expect(byLabel.get("Activity view")?.status).toBe("warning");
      expect(byLabel.get("WorktreeCreate hooks")?.detail).toBe("none");
      expect(byLabel.get("WorktreeRemove hooks")?.detail).toBe("none");
    }).pipe(Effect.scoped),
  );

  it.effect("names private state home-relative while checking the real directory", () =>
    Effect.gen(function* () {
      const missing = `.pi-subagents-doctor-missing-${process.pid}`;
      const byLabel = yield* checksByLabel({
        input: { agentDirectory: path.join(nodeDisplayHomeDirectory(), missing) },
      });
      expect(byLabel.get("Private state")).toMatchObject({
        status: "failed",
        detail: `~/${missing} is not writable`,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("names a removed Node home-relative while checking the real executable", () =>
    Effect.gen(function* () {
      const missing = `.pi-subagents-doctor-node-${process.pid}/bin/node`;
      const problem = yield* nodeExecutableProblem(path.join(nodeDisplayHomeDirectory(), missing));
      expect(problem).toContain(`~/${missing}`);
      expect(problem).not.toContain(nodeDisplayHomeDirectory());
    }),
  );

  it.effect("names the provider to sign in to when Pi knows none of a route's models", () =>
    Effect.gen(function* () {
      const byLabel = yield* checksByLabel({
        profiles: profileLayerFor({
          ...config,
          profileSets: {
            doctor: {
              profiles: {
                oracle: { ...pi("missing"), model: "elsewhere/missing" },
              },
            },
          },
        }),
      });
      const oracle = byLabel.get("Profile oracle");
      expect(oracle?.status).toBe("failed");
      expect(oracle?.detail).toContain("/login elsewhere");
    }).pipe(Effect.scoped),
  );

  it.effect("probes distinct routes concurrently, at most four at a time", () =>
    Effect.gen(function* () {
      // Each probe reports its admission, then holds its slot until the test releases one, so
      // admissions, not scheduling, show the bound.
      const admitted = yield* Queue.unbounded<void>();
      const releases = yield* Queue.unbounded<void>();
      let active = 0;
      let peak = 0;
      const probing = Layer.succeed(SubagentBackendRegistry, {
        spawn: () => Effect.die("doctor never launches"),
        preflight: () =>
          Effect.gen(function* () {
            active += 1;
            peak = Math.max(peak, active);
            yield* Queue.offer(admitted, undefined);
            yield* Queue.take(releases);
            active -= 1;
          }),
      });
      const routes = MODEL_IDS;
      const running = yield* checksByLabel({
        profiles: profileLayerFor({
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
        registry: probing,
      }).pipe(Effect.forkChild);
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
      const byLabel = yield* checksByLabel({
        profiles: subagentProfileServiceLayerFor(
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
        ),
      });
      const create = byLabel.get("WorktreeCreate hooks")?.detail ?? "";
      expect(Option.getOrElse(Fn.pipe(create, Str.indexOf("pnpm install")), () => -1)).toBeLessThan(
        Option.getOrElse(Fn.pipe(create, Str.indexOf("./copy-env")), () => -1),
      );
      expect(create).toContain("global");
      expect(create).toContain("project");
      expect(byLabel.get("WorktreeRemove hooks")?.detail).toContain("./prune");
    }).pipe(Effect.scoped),
  );
  it.effect("lists the checkout's .worktreeinclude patterns", () =>
    Effect.gen(function* () {
      const checkout = yield* temporaryDirectory("doctor-checkout-");
      yield* git(checkout, ["init", "--template="]);
      yield* writeFile(path.join(checkout, ".worktreeinclude"), "# local\n.env\nconfig/*.local\n");
      const byLabel = yield* checksByLabel({
        input: { ctx: doctorContext({ cwd: checkout }), projectTrusted: false },
      });
      const included = byLabel.get(".worktreeinclude");
      expect(included?.status).toBe("ok");
      expect(included?.detail).toContain(".env");
      expect(included?.detail).toContain("config/*.local");
      expect(included?.detail).not.toContain("#");
    }).pipe(Effect.scoped),
  );
  it.effect("checks each custom agent's route and reports invalid agents", () =>
    Effect.gen(function* () {
      const probed: string[] = [];
      const byLabel = yield* checksByLabel({
        profiles: profileLayerFor({
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
        registry: registry(probed),
      });
      expect(byLabel.get("Agent fast-review")?.status).toBe("ok");
      expect(byLabel.get("Agent strict-review")?.status).toBe("warning");
      expect(byLabel.get("Agent broken")?.status).toBe("failed");
      // Agents share routes with their profiles, which are probed once.
      expect(Arr.filter(probed, (model) => model === "test/haiku")).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});
