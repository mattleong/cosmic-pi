import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeSpawn, nodeSpawnSync } from "../src/platform/node-builtins.ts";
import {
  currentProcessIdentity,
  processLiveness,
  processStartIdentity,
} from "../src/platform/process-start.ts";
import { reusedProcessIdentity } from "../testing.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it("treats a live PID with a different comparable start identity as reused, so dead", () => {
    expect(processLiveness(reusedProcessIdentity())).toBe("dead");
  });

  it("cannot prove a live PID without a start identity is the same process", () => {
    expect(processLiveness({ pid: process.pid })).toBe("unknown");
  });

  it("never treats incomparable start evidence as death", () => {
    for (const started of [
      "an earlier process",
      // Local-time `lstart` text, as an environment-dependent reader would have recorded it.
      "Mon Oct 19 05:54:19 2026",
      "other-scheme:12345",
      `${currentProcessIdentity().started ?? ""} `,
    ])
      expect(processLiveness({ pid: process.pid, started })).toBe("unknown");
  });

  it("reads the same start identity whatever the time zone and locale", () => {
    const child = nodeSpawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      stdio: "ignore",
    });
    try {
      const pid = child.pid ?? 0;
      vi.stubEnv("TZ", "Pacific/Kiritimati");
      vi.stubEnv("LC_ALL", "fr_FR.UTF-8");
      const recorded = processStartIdentity(pid);
      expect(recorded).toBeDefined();

      vi.stubEnv("TZ", "America/Los_Angeles");
      vi.stubEnv("LC_ALL", "C");
      expect(processStartIdentity(pid)).toBe(recorded);
      expect(processLiveness({ pid, started: recorded })).toBe("alive");
    } finally {
      child.kill("SIGKILL");
    }
  });
});
