import type {
  ExtensionAPI,
  BeforeAgentStartEvent,
  ExtensionContext,
  ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerHerdrBtwParentReference } from "../src/boundary/host-parent-reference.ts";
import type {
  SessionFileIdentityComparison,
  SessionHeaderProbe,
} from "../src/boundary/session-file.ts";
import { resolveParentReferenceCandidate } from "../src/parent-link/policy.ts";

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
  readonly identityResult?: SessionFileIdentityComparison;
  readonly hostileFlag?: boolean;
  readonly hostileIdentity?: boolean;
  readonly hostileProbe?: boolean;
  readonly hostileSessionFile?: boolean;
  readonly hostileSessionId?: boolean;
}

const harness = (options: HarnessOptions = {}) => {
  const handlers = new Map<string, Handler[]>();
  const registerFlag = vi.fn();
  const probe = vi.fn((_path: string): SessionHeaderProbe => {
    if (options.hostileProbe) throw new Error("host-probe-secret");
    return options.probeResult ?? { _tag: "valid", header: { id: PARENT_ID } };
  });
  const compareIdentity = vi.fn(
    (leftPath: string, rightPath: string): SessionFileIdentityComparison => {
      if (options.hostileIdentity) throw new Error("host-identity-secret");
      return options.identityResult ?? (leftPath === rightPath ? "same" : "distinct");
    },
  );
  const piFixture = {
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerFlag,
    getFlag: (name: string) => {
      if (options.hostileFlag) throw new Error("host-flag-secret");
      if (name === "herdr-btw-parent") return options.flag;
      if (name === "herdr-btw-parent-file") return options.parentSession;
      if (name === "herdr-btw-child-session") return options.sessionId ?? "child-id";
      return undefined;
    },
  };
  // SAFETY: The registration uses only the ExtensionAPI members implemented here.
  const pi = piFixture as typeof piFixture & ExtensionAPI;
  const bridge = registerHerdrBtwParentReference(pi, { compareIdentity, probe });

  const makeCtx = (override: Partial<HarnessOptions> = {}) => {
    const merged = { ...options, ...override };
    const contextFixture = {
      sessionManager: {
        getSessionId: () => {
          if (merged.hostileSessionId) throw new Error("host-session-id-secret");
          return merged.sessionId ?? "child-id";
        },
        getSessionFile: () => {
          if (merged.hostileSessionFile) throw new Error("host-session-file-secret");
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
  const sections: BeforeAgentStartEvent["systemPromptOptions"]["sections"] = {
    another_extension: "keep me",
  };
  const beforeAgentStart = () => {
    const result = invoke(
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "p",
        systemPrompt: BASE_PROMPT,
        systemPromptOptions: { sections },
      },
      makeCtx(),
    );
    expect(result).toBeUndefined();
    expect(sections.another_extension).toBe("keep me");
    return sections.herdr_btw_parent_reference;
  };

  return {
    beforeAgentStart,
    compareIdentity,
    makeCtx,
    probe,
    registerFlag,
    sessionShutdown,
    sessionStart,
  };
};

describe("herdr-btw parent reference", () => {
  it("resolves marker and owning-child policy without host probing", () => {
    expect(
      resolveParentReferenceCandidate({
        parentIdMarker: PARENT_ID,
        parentFileMarker: PARENT_FILE,
        childSessionMarker: "child-id",
        sessionId: "child-id",
        sessionFile: CHILD_FILE,
      }),
    ).toEqual({ path: PARENT_FILE, id: PARENT_ID });
    expect(
      resolveParentReferenceCandidate({
        parentIdMarker: PARENT_ID,
        parentFileMarker: PARENT_FILE,
        childSessionMarker: "another-child",
        sessionId: "child-id",
        sessionFile: CHILD_FILE,
      }),
    ).toBeUndefined();
  });

  it("registers the marker as a string extension CLI flag", () => {
    const h = harness();
    for (const name of ["herdr-btw-parent", "herdr-btw-parent-file", "herdr-btw-child-session"])
      expect(h.registerFlag).toHaveBeenCalledWith(
        name,
        expect.objectContaining({ type: "string" }),
      );
  });

  it("appends a stable instruction with the JSON-quoted parent path and expected ID", () => {
    const parentFile = '/sessions/parent "quoted" \\ file.jsonl';
    const h = harness({ flag: PARENT_ID, parentSession: parentFile });
    h.sessionStart();
    const result = h.beforeAgentStart();
    expect(result).toContain(JSON.stringify(parentFile));
    expect(result).toContain(PARENT_ID);
    expect(result).toContain("append-only");
    expect(result).toContain("read-only");
    expect(h.beforeAgentStart()).toBe(result);
  });

  it("drops the instruction when per-run parent identity revalidation fails", () => {
    const failures: Array<SessionHeaderProbe | Error> = [
      { _tag: "invalid" },
      { _tag: "valid", header: { id: "another-parent" } },
      new Error("probe-secret"),
    ];
    for (const failure of failures) {
      const h = harness({ flag: PARENT_ID, parentSession: PARENT_FILE });
      h.sessionStart();
      expect(h.beforeAgentStart()).toBeDefined();
      if (failure instanceof Error)
        h.probe.mockImplementationOnce(() => {
          throw failure;
        });
      else h.probe.mockReturnValueOnce(failure);

      expect(h.beforeAgentStart()).toBeUndefined();
      expect(h.beforeAgentStart()).toBeUndefined();
      expect(h.probe).toHaveBeenCalledTimes(3);
    }
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

  it("requires a bounded parent-file marker", () => {
    for (const parentSession of [undefined, "", "a".repeat(4_097), "/sessions/bad\nname"]) {
      const h = harness({ flag: PARENT_ID, parentSession });
      h.sessionStart();
      expect(h.beforeAgentStart()).toBeUndefined();
      expect(h.probe).not.toHaveBeenCalled();
    }
  });

  it("rejects a self-referential parent pointer with a cheap raw-path check", () => {
    const h = harness({ flag: PARENT_ID, parentSession: CHILD_FILE, sessionFile: CHILD_FILE });
    h.sessionStart();
    expect(h.beforeAgentStart()).toBeUndefined();
    expect(h.compareIdentity).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
  });

  it("rejects parent-child filesystem aliases and unavailable identity", () => {
    for (const identityResult of ["same", "unavailable"] as const) {
      const h = harness({
        flag: PARENT_ID,
        parentSession: "/sessions/parent-alias.jsonl",
        sessionFile: CHILD_FILE,
        identityResult,
      });
      h.sessionStart();
      expect(h.beforeAgentStart()).toBeUndefined();
      expect(h.compareIdentity).toHaveBeenCalledWith("/sessions/parent-alias.jsonl", CHILD_FILE);
      expect(h.probe).not.toHaveBeenCalled();
    }
  });

  it("drops an active reference when parent and child become aliases", () => {
    const h = harness({ flag: PARENT_ID, parentSession: PARENT_FILE });
    h.sessionStart();
    h.compareIdentity.mockReturnValueOnce("same");

    expect(h.beforeAgentStart()).toBeUndefined();
    expect(h.beforeAgentStart()).toBeUndefined();
    expect(h.probe).toHaveBeenCalledTimes(1);
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

  it("contains throwing flag, session, and header-probe boundaries", () => {
    for (const hostile of [
      { hostileFlag: true },
      { hostileSessionId: true },
      { hostileSessionFile: true },
      { hostileIdentity: true },
      { hostileProbe: true },
    ]) {
      const h = harness({ flag: PARENT_ID, parentSession: PARENT_FILE, ...hostile });
      h.sessionStart();
      expect(h.beforeAgentStart()).toBeUndefined();
    }
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
