import { describe, expect, test, vi } from "vitest";
import { FooterContributionRegistry } from "../src/footer/registry.ts";

function surface(overrides: Record<string, unknown> = {}) {
  return {
    kind: "surface" as const,
    id: "media",
    region: "media" as const,
    preferredWidth: 10,
    render: () => [],
    attach: vi.fn(),
    detach: vi.fn(),
    invalidate: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  };
}

describe("FooterContributionRegistry", () => {
  test("attaches, detaches, invalidates, replaces, and disposes surfaces exactly once", () => {
    const registry = new FooterContributionRegistry();
    const render = vi.fn();
    const first = surface();
    const second = surface();
    registry.upsert("owner", first);
    registry.setRenderRequest(render);
    expect(first.attach).toHaveBeenCalledOnce();
    registry.invalidate("owner", "media");
    expect(first.invalidate).toHaveBeenCalledOnce();
    registry.upsert("owner", second);
    expect(first.detach).toHaveBeenCalledOnce();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.attach).toHaveBeenCalledOnce();
    registry.setRenderRequest(undefined);
    expect(second.detach).toHaveBeenCalledOnce();
    registry.clear();
    registry.clear();
    expect(second.dispose).toHaveBeenCalledOnce();
  });

  test("isolates throwing third-party callbacks while completing all cleanup", () => {
    const registry = new FooterContributionRegistry();
    const calls: string[] = [];
    const throwing = surface({
      attach: () => {
        calls.push("attach");
        throw new Error("attach");
      },
      detach: () => {
        calls.push("detach");
        throw new Error("detach");
      },
      invalidate: () => {
        calls.push("invalidate");
        throw new Error("invalidate");
      },
      dispose: () => {
        calls.push("dispose");
        throw new Error("dispose");
      },
    });
    const healthy = surface({ id: "healthy", dispose: vi.fn(), detach: vi.fn() });
    registry.upsert("owner", throwing);
    registry.upsert("owner", healthy);
    registry.setRenderRequest(() => {
      throw new Error("render");
    });
    expect(() => registry.invalidate()).not.toThrow();
    expect(() => registry.requestRenderNow()).not.toThrow();
    expect(() => registry.clear()).not.toThrow();
    expect(calls).toEqual(["attach", "invalidate", "detach", "dispose"]);
    expect(healthy.detach).toHaveBeenCalledOnce();
    expect(healthy.dispose).toHaveBeenCalledOnce();
    expect(registry.list()).toEqual([]);
  });
});
