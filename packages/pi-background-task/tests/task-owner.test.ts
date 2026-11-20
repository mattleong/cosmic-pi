import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { parkTaskOwner, takeTaskOwner, taskOwner } from "../src/boundary/task-owner.ts";

const sessionKey = () => {
  const cwd = process.cwd();
  const manager = SessionManager.inMemory(cwd);
  return { manager, sessionId: manager.getSessionId(), cwd, projectTrusted: true };
};

const parkedOwner = (key: ReturnType<typeof sessionKey>) => {
  const owner = taskOwner();
  const close = vi.spyOn(owner, "dispose");
  const timer = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timer.signal);
  try {
    parkTaskOwner(key, owner);
  } finally {
    timeout.mockRestore();
  }
  return { owner, close, expire: () => timer.abort() };
};

describe("task owner reload lease", () => {
  it("hands off once to the same live session, not another manager with the same ID", () => {
    const key = sessionKey();
    const { owner, close, expire } = parkedOwner(key);
    const otherManager = SessionManager.inMemory(key.cwd);
    expect(takeTaskOwner({ ...key, manager: otherManager }, true).owner).toBeUndefined();
    expect(takeTaskOwner(key, true).owner).toBe(owner);
    expect(takeTaskOwner(key, true).owner).toBeUndefined();
    expire();
    expect(close).not.toHaveBeenCalled();
    return owner.dispose();
  });

  it("closes an unclaimed owner when the lease expires", () => {
    const key = sessionKey();
    const { close, expire } = parkedOwner(key);
    expire();
    expect(close).toHaveBeenCalledOnce();
    expect(takeTaskOwner(key, true).owner).toBeUndefined();
  });

  it.each([false, true])("closes an owner instead of adopting it (reload: %s)", (reload) => {
    const key = sessionKey();
    const { close, expire } = parkedOwner(key);
    const candidate = reload ? { ...key, projectTrusted: false } : key;
    const result = takeTaskOwner(candidate, reload);
    expect(result.owner).toBeUndefined();
    if (!result.cleanup) throw new Error("A mismatched lease wasn't closed");
    return result.cleanup.then(() => {
      expire();
      expect(close).toHaveBeenCalledOnce();
      return undefined;
    });
  });
});
