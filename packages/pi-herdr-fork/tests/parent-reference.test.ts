import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { SessionHeaderProbe } from "../src/boundary/session-file.ts";
import { registerHerdrForkParentReference } from "../src/parent-link/register.ts";

type Handler = ExtensionHandler<any, any>;

const PARENT_FILE = "/sessions/parent.jsonl";
const PARENT_ID = "019fd4cd-4c88-7564-8b67-3b917b42df51";
const CHILD_FILE = "/sessions/child.jsonl";
const BASE_PROMPT = "You are a helpful agent.";

interface HarnessOptions {
  readonly flag?: string | boolean | undefined;
  readonly sessionId?: string;
  readonly sessionFile?: string | null;
  readonly parentSession?: string | undefined;
  readonly probeResult?: SessionHeaderProbe;
  readonly hostileHeader?: boolean;
}

const harness = (options: HarnessOptions = {}) => {
  const handlers = new Map<string, Handler[]>();
  const registerFlag = vi.fn();
  const probe = vi.fn(
    (_path: string): SessionHeaderProbe =>
      options.probeResult ?? { _tag: "valid", header: { id: PARENT_ID } },
  );
  const piFixture = {
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerFlag,
    getFlag: (name: string) => {
      if (name === "herdr-fork-parent") return options.flag;
      if (name === "herdr-fork-parent-file") return options.parentSession;
      if (name === "herdr-fork-child-session") return options.sessionId ?? "child-id";
      return undefined;
    },
  };
  // SAFETY: The registration uses only the ExtensionAPI members implemented here.
  const pi = piFixture as typeof piFixture & ExtensionAPI;
  const bridge = registerHerdrForkParentReference(pi, { probe });

  const makeCtx = (override: Partial<HarnessOptions> = {}) => {
    const merged = { ...options, ...override };
    const contextFixture = {
      sessionManager: {
        getSessionId: () => merged.sessionId ?? "child-id",
        getSessionFile: () => {
          if (merged.hostileHeader) throw new Error("host-session-secret");
          return merged.sessionFile ?? CHILD_FILE;
        },
      },
    };
    // SAFETY: The registration uses only the ExtensionContext members implemented here.
    return contextFixture as typeof contextFixture & ExtensionContext;
  };

  const invoke = <EventInput>(name: string, event: EventInput, ctx: ExtensionContext) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) result = handler(event, ctx);
    return result;
  };
  const sessionStart = (ctx = makeCtx()) => bridge.activate(bridge.capture(ctx));
  const sessionShutdown = () => bridge.clear();
  const beforeAgentStart = () =>
    // SAFETY: The registered before_agent_start handler only ever returns this
    // optional system-prompt result shape.
    invoke(
      "before_agent_start",
      { type: "before_agent_start", prompt: "p", systemPrompt: BASE_PROMPT },
      makeCtx(),
    ) as { systemPrompt?: string } | undefined;

  return { beforeAgentStart, makeCtx, probe, registerFlag, sessionShutdown, sessionStart };
};

describe("herdr-fork parent reference", () => {
  it("registers the marker as a string extension CLI flag", () => {
    const h = harness();
    for (const name of ["herdr-fork-parent", "herdr-fork-parent-file", "herdr-fork-child-session"])
      expect(h.registerFlag).toHaveBeenCalledWith(
        name,
        expect.objectContaining({ type: "string" }),
      );
  });

  it("appends a stable instruction with the JSON-quoted parent path and expected ID", () => {
    const h = harness({ flag: PARENT_ID, parentSession: PARENT_FILE });
    h.sessionStart();
    const result = h.beforeAgentStart();
    expect(result?.systemPrompt?.startsWith(BASE_PROMPT)).toBe(true);
    expect(result?.systemPrompt).toContain(JSON.stringify(PARENT_FILE));
    expect(result?.systemPrompt).toContain(PARENT_ID);
    expect(result?.systemPrompt).toContain("append-only");
    expect(result?.systemPrompt).toContain("read-only");
  });

  it("revalidates identity per run without reading parent transcript content", () => {
    const h = harness({ flag: PARENT_ID, parentSession: PARENT_FILE });
    h.sessionStart();
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.probe).toHaveBeenCalledWith(PARENT_FILE);
    h.beforeAgentStart();
    h.beforeAgentStart();
    expect(h.probe).toHaveBeenCalledTimes(3);
  });

  it("drops the instruction when per-run parent identity revalidation fails", () => {
    const h = harness({ flag: PARENT_ID, parentSession: PARENT_FILE });
    h.sessionStart();
    h.probe.mockReturnValueOnce({ _tag: "invalid" });

    expect(h.beforeAgentStart()).toBeUndefined();
    expect(h.beforeAgentStart()).toBeUndefined();
    expect(h.probe).toHaveBeenCalledTimes(2);
  });

  it("stays inactive in unmarked Pi processes", () => {
    const h = harness({ flag: undefined, parentSession: PARENT_FILE });
    h.sessionStart();
    expect(h.beforeAgentStart()).toBeUndefined();
    expect(h.probe).not.toHaveBeenCalled();
  });

  it("rejects a non-string or malformed marker value", () => {
    for (const flag of [true, "", "has spaces", "-leading", "a".repeat(200), "x\ny"]) {
      const h = harness({ flag, parentSession: PARENT_FILE });
      h.sessionStart();
      expect(h.beforeAgentStart()).toBeUndefined();
    }
  });

  it("requires the parent-file marker", () => {
    const h = harness({ flag: PARENT_ID, parentSession: undefined });
    h.sessionStart();
    expect(h.beforeAgentStart()).toBeUndefined();
    expect(h.probe).not.toHaveBeenCalled();
  });

  it("rejects a self-referential parent pointer", () => {
    const h = harness({ flag: PARENT_ID, parentSession: CHILD_FILE, sessionFile: CHILD_FILE });
    h.sessionStart();
    expect(h.beforeAgentStart()).toBeUndefined();
    expect(h.probe).not.toHaveBeenCalled();
  });

  it("rejects a missing, symlinked, or malformed parent file", () => {
    const h = harness({
      flag: PARENT_ID,
      parentSession: PARENT_FILE,
      probeResult: { _tag: "invalid" },
    });
    h.sessionStart();
    expect(h.beforeAgentStart()).toBeUndefined();
  });

  it("rejects a parent header whose ID does not match the marker", () => {
    const h = harness({
      flag: PARENT_ID,
      parentSession: PARENT_FILE,
      probeResult: { _tag: "valid", header: { id: "some-other-session" } },
    });
    h.sessionStart();
    expect(h.beforeAgentStart()).toBeUndefined();
  });

  it("deactivates fail-closed when the host session getters throw", () => {
    const h = harness({ flag: PARENT_ID, parentSession: PARENT_FILE, hostileHeader: true });
    h.sessionStart(h.makeCtx({ hostileHeader: true }));
    expect(h.beforeAgentStart()).toBeUndefined();
  });

  it("clears and refreshes the reference across session replacement", () => {
    const h = harness({ flag: PARENT_ID, parentSession: PARENT_FILE });
    h.sessionStart();
    expect(h.beforeAgentStart()).toBeDefined();
    // Replacement with another child session ID clears the process-scoped reference.
    h.sessionStart(h.makeCtx({ sessionId: "other-child" }));
    expect(h.beforeAgentStart()).toBeUndefined();
    // A later matching session start reactivates it.
    h.sessionStart();
    expect(h.beforeAgentStart()).toBeDefined();
  });

  it("clears the reference on session shutdown", () => {
    const h = harness({ flag: PARENT_ID, parentSession: PARENT_FILE });
    h.sessionStart();
    expect(h.beforeAgentStart()).toBeDefined();
    h.sessionShutdown();
    expect(h.beforeAgentStart()).toBeUndefined();
  });
});
