import { describe, expect, it } from "vitest";
import { nodeSpawnSync } from "../src/platform/node-builtins.ts";
import { currentProcessIdentity, processLiveness } from "../src/platform/process-start.ts";

describe("process liveness", () => {
  it("treats the current process as alive", () => {
    const identity = currentProcessIdentity();
    expect(identity.pid).toBe(process.pid);
    expect(processLiveness(identity)).toBe("alive");
  });

  it("treats an exited process as dead", () => {
    const exited = nodeSpawnSync(process.execPath, ["-e", ""]);
    expect(processLiveness({ pid: exited.pid, started: "whenever" })).toBe("dead");
  });

  it("treats a live PID with a different start identity as reused, so dead", () => {
    expect(processLiveness({ pid: process.pid, started: "an earlier process" })).toBe("dead");
  });

  it("cannot prove a live PID without a start identity is the same process", () => {
    expect(processLiveness({ pid: process.pid })).toBe("unknown");
  });
});
