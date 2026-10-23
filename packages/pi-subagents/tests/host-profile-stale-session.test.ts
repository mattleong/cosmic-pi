import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { nodeFilePlatformLayer, SafeFile } from "pi-cosmic-core";
import { extensionApiFixture, extensionContextFixture } from "pi-cosmic-core/testing";
import { runSubagentDoctor } from "../src/application/doctor.ts";
import { SubagentBackendRegistry } from "../src/backend/service.ts";
import { resolveProfileStart } from "../src/boundary/host-profile-resolution.ts";
import type { ProfileCandidate } from "../src/profiles/model.ts";
import { SubagentProfileService } from "../src/profiles/service.ts";
import { InvalidSubagentRequestError } from "../src/run/errors.ts";
import type { SubagentParentContext } from "../src/run/model.ts";
import { SubagentService } from "../src/run/service.ts";
import { executeSubagentActionEffect } from "../src/tools/execute.ts";
import type { SubagentToolInput } from "../src/tools/schema.ts";
import { subagentServiceDouble } from "./tools/fixtures/subagent-service-double.ts";
import {
  context,
  fallbackProfileService,
  profileServiceFor,
  testBackendDriver,
  testBackendRegistry,
} from "./tools/fixtures/tool-harness.ts";

const route = (overrides: Partial<ProfileCandidate> = {}): ProfileCandidate => ({
  runtime: "pi",
  model: "parent",
  effort: "default",
  context: "fresh",
  writeIntent: "read-only",
  ...overrides,
});

const parentContext: SubagentParentContext = {
  sessionId: "parent-session",
  model: "openai-codex/gpt-5.6-sol",
  effort: "high",
};

/** Mirrors Pi, whose context getters and extension API throw once the session is replaced. */
const retirableSession = () => {
  let retired = false;
  const assertActive = () => {
    if (retired) throw new Error("This extension ctx is stale after session replacement.");
  };
  const { modelRegistry, model } = context;
  const ctx = Object.defineProperties(extensionContextFixture({ cwd: "/project" }), {
    modelRegistry: {
      get: () => {
        assertActive();
        return modelRegistry;
      },
    },
    model: {
      get: () => {
        assertActive();
        return model;
      },
    },
  });
  const pi = extensionApiFixture({
    getThinkingLevel: () => {
      assertActive();
      return "high";
    },
    getActiveTools: () => {
      assertActive();
      return ["read"];
    },
  });
  return { ctx, pi, retire: () => void (retired = true) };
};

describe("profile start on a retired session", () => {
  it.effect("fails with a typed error when the session retires during candidate probes", () =>
    Effect.gen(function* () {
      const session = retirableSession();
      let probes = 0;
      const registry = {
        ...testBackendRegistry,
        preflight: () => {
          probes += 1;
          if (probes > 1) return Effect.succeed(testBackendDriver);
          session.retire();
          return Effect.fail(
            InvalidSubagentRequestError.make({ code: "probe_failed", message: "Probe failed." }),
          );
        },
      };
      const error = yield* resolveProfileStart(
        session.pi,
        { profile: "reviewer", task: "Review" },
        session.ctx,
        { cwd: "/project", projectTrusted: true, parentContext },
      ).pipe(
        Effect.provideService(
          SubagentProfileService,
          profileServiceFor({
            profiles: { reviewer: [route({ model: "openai-codex/gpt-5.6-sol" }), route()] },
          }),
        ),
        Effect.provideService(SubagentBackendRegistry, registry),
        Effect.flip,
      );
      // The second candidate still resolved its model after the session retired.
      expect(probes).toBe(2);
      expect(error).toBeInstanceOf(InvalidSubagentRequestError);
      expect(error.code).toBe("host_session_unavailable");
    }),
  );

  for (const parent of [undefined, parentContext])
    it.effect(
      `fails with a typed error when the session already retired (${parent ? "captured" : "live"} parent)`,
      () =>
        Effect.gen(function* () {
          const session = retirableSession();
          session.retire();
          const error = yield* resolveProfileStart(session.pi, { task: "Review" }, session.ctx, {
            cwd: "/project",
            projectTrusted: true,
            ...(parent && { parentContext: parent }),
          }).pipe(
            Effect.provideService(SubagentProfileService, profileServiceFor(undefined)),
            Effect.provideService(SubagentBackendRegistry, testBackendRegistry),
            Effect.flip,
          );
          expect(error).toBeInstanceOf(InvalidSubagentRequestError);
          expect(error.code).toBe("host_session_unavailable");
        }),
    );
});

describe("tool and doctor host reads on a retired session", () => {
  const environment = { cwd: "/project", projectTrusted: true };
  const execute = (session: ReturnType<typeof retirableSession>, input: SubagentToolInput) =>
    executeSubagentActionEffect(session.pi, environment, input, undefined, session.ctx).pipe(
      Effect.provideService(SubagentService, subagentServiceDouble({})),
      Effect.provideService(SubagentProfileService, fallbackProfileService),
      Effect.provideService(SubagentBackendRegistry, testBackendRegistry),
      Effect.flip,
    );

  it.effect("fails agent_profiles with a typed error", () =>
    Effect.gen(function* () {
      const session = retirableSession();
      session.retire();
      const error = yield* execute(session, { tool: "agent_profiles", args: {} });
      expect(error).toMatchObject({ code: "host_session_unavailable" });
    }),
  );

  it.effect("fails agent_start with a typed error before any launch", () =>
    Effect.gen(function* () {
      const session = retirableSession();
      session.retire();
      // The service double dies on any launch, so a typed failure proves none was attempted.
      const error = yield* execute(session, {
        tool: "agent_start",
        args: { agents: [{ task: "Review" }] },
      });
      expect(error).toMatchObject({ code: "host_session_unavailable" });
    }),
  );

  it.effect("fails the doctor with a typed error", () =>
    Effect.gen(function* () {
      const session = retirableSession();
      session.retire();
      const error = yield* runSubagentDoctor({
        pi: session.pi,
        ctx: session.ctx,
        agentDirectory: "/agent",
        activityViewAvailable: undefined,
        projectTrusted: true,
      }).pipe(
        Effect.provideService(SubagentProfileService, fallbackProfileService),
        Effect.provideService(SubagentBackendRegistry, testBackendRegistry),
        Effect.provide(SafeFile.layer.pipe(Layer.provideMerge(nodeFilePlatformLayer))),
        Effect.flip,
      );
      expect(error).toMatchObject({ code: "host_session_unavailable" });
    }),
  );
});
