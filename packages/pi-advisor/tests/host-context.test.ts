import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import {
  AdvisorHostContextError,
  captureAdvisorSessionInputAtHostBoundary,
  registerAdvisorAbortListenerAtHostBoundary,
} from "../src/boundary/host-context.ts";

const abortSignalFixture = <Fixture extends object>(fixture: Fixture): Fixture & AbortSignal => {
  // SAFETY: Each caller exercises only the AbortSignal members implemented by its fixture.
  return fixture as Fixture & AbortSignal;
};

interface TestAbortSignal {
  readonly signal: AbortSignal;
  readonly addCount: () => number;
  readonly removeCount: () => number;
}

const makeAbortSignal = (
  options: {
    readonly aborted?: boolean;
    readonly onAdd?: (listener: () => void) => void;
    readonly onRemove?: (listener: () => void) => void;
  } = {},
): TestAbortSignal => {
  let addCount = 0;
  let removeCount = 0;
  // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
  const signal = {
    get aborted() {
      return options.aborted ?? false;
    },
    addEventListener(_type: string, listener: () => void) {
      addCount += 1;
      options.onAdd?.(listener);
    },
    removeEventListener(_type: string, listener: () => void) {
      removeCount += 1;
      options.onRemove?.(listener);
    },
  } as AbortSignal;
  return {
    signal,
    addCount: () => addCount,
    removeCount: () => removeCount,
  };
};

// SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
const safeContext = (): ExtensionContext =>
  Object.defineProperties(
    {},
    {
      cwd: { configurable: true, get: () => "/tmp/advisor-project" },
      modelRegistry: { configurable: true, get: () => ({}) },
      signal: { configurable: true, get: () => makeAbortSignal().signal },
      isProjectTrusted: { configurable: true, get: () => () => true },
    },
  ) as ExtensionContext;

describe("advisor host-context boundary", () => {
  it("captures every guarded session input exactly once", () => {
    const reads = {
      cwd: 0,
      modelRegistry: 0,
      signal: 0,
      aborted: 0,
      isProjectTrusted: 0,
      projectTrustCall: 0,
    };
    const modelRegistry = { marker: "captured-registry" };
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const signal = {
      get aborted() {
        reads.aborted += 1;
        return true;
      },
    } as AbortSignal;
    let ctx!: ExtensionContext;
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    ctx = Object.defineProperties(
      {},
      {
        cwd: {
          get: () => {
            reads.cwd += 1;
            return "/tmp/advisor-project";
          },
        },
        modelRegistry: {
          get: () => {
            reads.modelRegistry += 1;
            return modelRegistry;
          },
        },
        signal: {
          get: () => {
            reads.signal += 1;
            return signal;
          },
        },
        isProjectTrusted: {
          get: () => {
            reads.isProjectTrusted += 1;
            return function (this: ExtensionContext) {
              reads.projectTrustCall += 1;
              expect(this).toBe(ctx);
              return true;
            };
          },
        },
      },
    ) as ExtensionContext;

    const result = captureAdvisorSessionInputAtHostBoundary(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.ctx).toBe(ctx);
    expect(result.input.cwd).toBe("/tmp/advisor-project");
    expect(result.input.modelRegistry).toBe(modelRegistry);
    expect(result.input.projectTrusted).toBe(true);
    expect(result.input.signal).toBe(signal);
    expect(result.input.signalAborted).toBe(true);
    expect(reads).toEqual({
      cwd: 1,
      modelRegistry: 1,
      signal: 1,
      aborted: 1,
      isProjectTrusted: 1,
      projectTrustCall: 1,
    });
  });

  it("removes the listener from the captured signal when the host getter later changes", () => {
    let firstListener: (() => void) | undefined;
    const first = makeAbortSignal({
      onAdd: (listener) => {
        firstListener = listener;
      },
      onRemove: (listener) => expect(listener).toBe(firstListener),
    });
    const second = makeAbortSignal();
    let signalReads = 0;
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const ctx = Object.defineProperties(safeContext(), {
      signal: {
        configurable: true,
        get: () => {
          signalReads += 1;
          return signalReads === 1 ? first.signal : second.signal;
        },
      },
    }) as ExtensionContext;

    const captured = captureAdvisorSessionInputAtHostBoundary(ctx);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(ctx.signal).toBe(second.signal);

    const registered = registerAdvisorAbortListenerAtHostBoundary(captured.input, () => {});
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    registered.registration.remove();

    expect(signalReads).toBe(2);
    expect(first.addCount()).toBe(1);
    expect(first.removeCount()).toBe(1);
    expect(second.addCount()).toBe(0);
    expect(second.removeCount()).toBe(0);
  });

  it("removes a partially registered listener when addEventListener stores then throws", () => {
    const secret = "host-add-secret";
    let storedListener: (() => void) | undefined;
    let removedListener: (() => void) | undefined;
    const hostile = makeAbortSignal({
      onAdd: (listener) => {
        storedListener = listener;
        throw new Error(secret);
      },
      onRemove: (listener) => {
        removedListener = listener;
      },
    });

    const result = registerAdvisorAbortListenerAtHostBoundary(
      { signal: hostile.signal, signalAborted: false },
      () => {},
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AdvisorHostContextError);
    expect(result.error).toMatchObject({
      _tag: "AdvisorHostContextError",
      operation: "abort-listener",
      message: "Advisor could not observe host cancellation safely.",
    });
    expect(JSON.stringify(result.error)).not.toContain(secret);
    expect(hostile.addCount()).toBe(1);
    expect(hostile.removeCount()).toBe(1);
    expect(removedListener).toBe(storedListener);
  });

  it("redacts failures from every hostile session-input getter", () => {
    const secret = "host-session-secret";
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly make: () => ExtensionContext;
    }> = [
      {
        name: "cwd",
        make: () =>
          Object.defineProperty(safeContext(), "cwd", {
            get: () => {
              throw new Error(secret);
            },
          }),
      },
      {
        name: "modelRegistry",
        make: () =>
          Object.defineProperty(safeContext(), "modelRegistry", {
            get: () => {
              throw new Error(secret);
            },
          }),
      },
      {
        name: "signal",
        make: () =>
          Object.defineProperty(safeContext(), "signal", {
            get: () => {
              throw new Error(secret);
            },
          }),
      },
      {
        name: "signal.aborted",
        make: () =>
          Object.defineProperty(safeContext(), "signal", {
            get: () =>
              abortSignalFixture({
                get aborted() {
                  throw new Error(secret);
                },
              }),
          }),
      },
      {
        name: "isProjectTrusted getter",
        make: () =>
          Object.defineProperty(safeContext(), "isProjectTrusted", {
            get: () => {
              throw new Error(secret);
            },
          }),
      },
      {
        name: "isProjectTrusted call",
        make: () =>
          Object.defineProperty(safeContext(), "isProjectTrusted", {
            get: () => () => {
              throw new Error(secret);
            },
          }),
      },
    ];

    for (const testCase of cases) {
      const result = captureAdvisorSessionInputAtHostBoundary(testCase.make());
      expect(result.ok, testCase.name).toBe(false);
      if (result.ok) continue;
      expect(result.error, testCase.name).toBeInstanceOf(AdvisorHostContextError);
      expect(result.error, testCase.name).toMatchObject({
        _tag: "AdvisorHostContextError",
        operation: "session-input",
        message: "Advisor could not capture the host session safely.",
      });
      expect(JSON.stringify(result.error), testCase.name).not.toContain(secret);
    }
  });

  it("keeps a throwing removal no-throw and idempotent", () => {
    const hostile = makeAbortSignal({
      onRemove: () => {
        throw new Error("host-remove-secret");
      },
    });
    const result = registerAdvisorAbortListenerAtHostBoundary(
      { signal: hostile.signal, signalAborted: false },
      () => {},
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(() => result.registration.remove()).not.toThrow();
    expect(() => result.registration.remove()).not.toThrow();
    expect(hostile.removeCount()).toBe(1);
  });

  it("delivers a synchronous abort and an already-aborted snapshot exactly once", () => {
    let deliveries = 0;
    const signal = makeAbortSignal({
      aborted: true,
      onAdd: (listener) => listener(),
    });

    const result = registerAdvisorAbortListenerAtHostBoundary(
      { signal: signal.signal, signalAborted: true },
      () => {
        deliveries += 1;
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registration.aborted).toBe(true);
    expect(deliveries).toBe(1);
  });

  it("closes the race when the signal aborts after capture but before registration", () => {
    let aborted = false;
    let deliveries = 0;
    const signal = abortSignalFixture({
      get aborted() {
        return aborted;
      },
      addEventListener() {
        aborted = true;
      },
      removeEventListener() {},
    });

    const result = registerAdvisorAbortListenerAtHostBoundary(
      { signal, signalAborted: false },
      () => {
        deliveries += 1;
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registration.aborted).toBe(true);
    expect(deliveries).toBe(1);
  });
});
