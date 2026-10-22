import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { extensionApiFixture, extensionContextFixture } from "pi-cosmic-core/testing";
import { SubagentBackendRegistry } from "../src/backend/service.ts";
import { resolveProfileStart } from "../src/boundary/host-profile-resolution.ts";
import type { ProfileCandidate } from "../src/profiles/model.ts";
import { SubagentProfileService } from "../src/profiles/service.ts";
import { InvalidSubagentRequestError } from "../src/run/errors.ts";
import type { SubagentParentContext } from "../src/run/model.ts";
import {
  context,
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
            new InvalidSubagentRequestError({ code: "probe_failed", message: "Probe failed." }),
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
