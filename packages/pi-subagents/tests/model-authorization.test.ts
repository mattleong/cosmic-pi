// Promise assertions exercise the Pi confirmation boundary.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import {
  authorizeExplicitModelOverrides,
  consumeExplicitModelAuthorization,
  type ExplicitModelOverrideRequest,
} from "../src/boundary/host-model-authorization.ts";

const contextWithConfirmation = (
  confirm: (title: string, message: string, options?: unknown) => Promise<boolean>,
  hasUI = true,
): ExtensionContext =>
  ({
    hasUI,
    ui: { confirm },
  }) as unknown as ExtensionContext;

describe("explicit subagent model authorization", () => {
  it("renders every item in a maximum-size batch before issuing grants", async () => {
    let prompt = "";
    const confirm = vi.fn<(title: string, message: string, options?: unknown) => Promise<boolean>>(
      (_title, message) => {
        prompt = message;
        return Promise.resolve(true);
      },
    );
    const requests: ExplicitModelOverrideRequest[] = Array.from({ length: 12 }, (_, index) => ({
      index,
      name: `authorization-${index}-${"n".repeat(56)}`,
      selector: `pi/provider-${index}/${"m".repeat(480)}`,
      task: `Inspect authorization item ${index} ${"task ".repeat(200)}tail-${index}`,
    }));

    const grants = await Effect.runPromise(
      authorizeExplicitModelOverrides(requests, contextWithConfirmation(confirm)),
    );

    expect(confirm).toHaveBeenCalledOnce();
    expect(grants).toHaveLength(requests.length);
    for (const request of requests) {
      expect(prompt).toContain(request.name);
      expect(prompt).toContain(request.selector);
      expect(prompt).toContain(`${request.index + 1}.`);
      expect(prompt).toContain(`Inspect authorization item ${request.index}`);
      const grant = grants.find((candidate) => candidate.index === request.index);
      expect(
        consumeExplicitModelAuthorization(
          grant?.authorization,
          request.index,
          request.selector,
          request.task,
        ),
      ).toBe(true);
    }
    expect(prompt).toContain("chars]");
  });

  it("binds a grant to index, selector, and task and consumes it exactly once", async () => {
    const request: ExplicitModelOverrideRequest = {
      index: 3,
      selector: "pi/openai/model",
      task: "Review auth",
    };
    const [grant] = await Effect.runPromise(
      authorizeExplicitModelOverrides(
        [request],
        contextWithConfirmation(() => Promise.resolve(true)),
      ),
    );

    expect(
      consumeExplicitModelAuthorization(grant?.authorization, 4, request.selector, request.task),
    ).toBe(false);
    expect(
      consumeExplicitModelAuthorization(grant?.authorization, 3, "pi/openai/other", request.task),
    ).toBe(false);
    expect(
      consumeExplicitModelAuthorization(grant?.authorization, 3, request.selector, "Other task"),
    ).toBe(false);
    expect(
      consumeExplicitModelAuthorization(grant?.authorization, 3, request.selector, request.task),
    ).toBe(true);
    expect(
      consumeExplicitModelAuthorization(grant?.authorization, 3, request.selector, request.task),
    ).toBe(false);
  });

  it("fails closed when confirmation rejects or no UI is available", async () => {
    const request: ExplicitModelOverrideRequest = {
      index: 0,
      selector: "pi/openai/model",
      task: "Review auth",
    };
    await expect(
      Effect.runPromise(
        authorizeExplicitModelOverrides(
          [request],
          contextWithConfirmation(() => Promise.reject(new Error("host unavailable"))),
        ),
      ),
    ).rejects.toMatchObject({ code: "explicit_model_not_authorized" });

    const confirm = vi.fn(() => Promise.resolve(true));
    await expect(
      Effect.runPromise(
        authorizeExplicitModelOverrides([request], contextWithConfirmation(confirm, false)),
      ),
    ).rejects.toMatchObject({ code: "explicit_model_not_authorized" });
    expect(confirm).not.toHaveBeenCalled();
  });
});
