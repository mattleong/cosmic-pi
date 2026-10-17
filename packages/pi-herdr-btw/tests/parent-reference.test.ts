import type { BeforeAgentStartEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  extensionContextFixture,
  recordingExtensionHost,
  type RecordedHandler,
} from "pi-cosmic-core/testing";
import { describe, expect, it, vi } from "vitest";
import { registerHerdrBtwParentReference } from "../src/boundary/host-parent-reference.ts";
import {
  SessionHeaderProbe,
  type SessionFileIdentityComparison,
} from "../src/boundary/session-file.ts";

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
  const registerFlag = vi.fn();
  const probe = vi.fn((_path: string): SessionHeaderProbe => {
    if (options.hostileProbe) throw new Error("host-probe-secret");
    return options.probeResult ?? SessionHeaderProbe.valid({ header: { id: PARENT_ID } });
  });
  const compareIdentity = vi.fn(
    (leftPath: string, rightPath: string): SessionFileIdentityComparison => {
      if (options.hostileIdentity) throw new Error("host-identity-secret");
      return options.identityResult ?? (leftPath === rightPath ? "same" : "distinct");
    },
  );
  const { pi, handlers } = recordingExtensionHost(
    {},
    {
      registerFlag,
      getFlag: (name: string) => {
        if (options.hostileFlag) throw new Error("host-flag-secret");
        if (name === "herdr-btw-parent") return options.flag;
        if (name === "herdr-btw-parent-file") return options.parentSession;
        if (name === "herdr-btw-child-session") return options.sessionId ?? "child-id";
        return undefined;
      },
    },
  );
  const bridge = registerHerdrBtwParentReference(pi, { compareIdentity, probe });

  const makeCtx = (override: Partial<HarnessOptions> = {}) => {
    const merged = { ...options, ...override };
    return extensionContextFixture({
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
    });
  };

  const invokeBeforeAgentStart = (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    let result: ReturnType<RecordedHandler<"before_agent_start">> = undefined;
    for (const handler of handlers.get("before_agent_start") ?? []) result = handler(event, ctx);
    return result;
  };
  const sessionStart = (ctx = makeCtx()) => bridge.activate(bridge.capture(ctx));
  const sections: BeforeAgentStartEvent["systemPromptOptions"]["sections"] = {
    another_extension: "keep me",
  };
  const beforeAgentStart = () => {
    const result = invokeBeforeAgentStart(
      {
        type: "before_agent_start",
        messageType: "user",
        prompt: "p",
        systemPrompt: BASE_PROMPT,
        systemPromptOptions: {
          cwd: "/project",
          selectedTools: [],
          hiddenTools: [],
          toolSnippets: {},
          toolGuidelines: {},
          promptGuidelines: [],
          appendSystemPrompt: "",
          sections,
          contextFiles: [],
          skills: [],
        },
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
    sessionStart,
  };
};

describe("herdr-btw parent reference", () => {
  it("appends a stable instruction with the JSON-quoted parent path and expected ID", () => {
    const parentFile = '/sessions/parent "quoted" \\ file.jsonl';
    const h = harness({ flag: PARENT_ID, parentSession: parentFile });
    h.sessionStart();
    const result = h.beforeAgentStart();
    expect(result).toContain(JSON.stringify(parentFile));
    expect(result).toContain(PARENT_ID);
    expect(h.beforeAgentStart()).toBe(result);
  });

  it("drops the instruction when per-run parent identity revalidation fails", () => {
    const failures: Array<SessionHeaderProbe | Error> = [
      SessionHeaderProbe.invalid(),
      SessionHeaderProbe.valid({ header: { id: "another-parent" } }),
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

  it("clears and refreshes the reference across session replacement", () => {
    const h = harness({ flag: PARENT_ID, parentSession: PARENT_FILE });
    h.sessionStart();
    expect(h.beforeAgentStart()).toBeDefined();
    h.sessionStart(h.makeCtx({ sessionId: "other-child" }));
    expect(h.beforeAgentStart()).toBeUndefined();
    h.sessionStart();
    expect(h.beforeAgentStart()).toBeDefined();
  });
});
