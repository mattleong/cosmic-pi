import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { makeAskUserDialogBridge } from "../src/boundary/host-ui.ts";

// SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
const context = (setStatus: (key: string, value: string | undefined) => void) =>
  ({ mode: "tui", ui: { setStatus } }) as ExtensionContext;

describe("ask-user dialog bridge", () => {
  it("resumes the active dialog and ignores stale cleanup", () => {
    const statuses: Array<string | undefined> = [];
    const bridge = makeAskUserDialogBridge();
    bridge.setContext(context((_key, value) => statuses.push(value)));
    const first = bridge.activate({ resume: vi.fn() });
    const resume = vi.fn();
    const second = bridge.activate({ resume });

    bridge.clear(first);
    bridge.markCollapsed(second);
    expect(statuses.at(-1)).toContain("/ask-user");
    expect(bridge.resume()).toBe(true);
    expect(resume).toHaveBeenCalledOnce();
    expect(statuses.at(-1)).toBeUndefined();
  });

  it("clears status idempotently and reports no inactive resume", () => {
    const setStatus = vi.fn();
    const bridge = makeAskUserDialogBridge();
    bridge.setContext(context(setStatus));
    const token = bridge.activate({ resume: vi.fn() });
    bridge.clear(token);
    bridge.clear(token);
    expect(bridge.resume()).toBe(false);
    expect(setStatus).toHaveBeenLastCalledWith("pi-ask-user", undefined);
  });
});
