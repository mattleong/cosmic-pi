import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeLockFs, nodeSpawn, nodeSpawnSync } from "../src/platform/node-builtins.ts";
import {
  currentProcessIdentity,
  probeProcessLiveness,
  processLiveness,
  processStartIdentity,
  type ProcessIdentity,
} from "../src/platform/process-start.ts";
import { reusedProcessIdentity } from "../testing.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

describe("non-blocking process liveness", () => {
  const waitingChild = Effect.acquireRelease(
    Effect.sync(() =>
      nodeSpawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" }),
    ),
    (child) => Effect.sync(() => child.kill("SIGKILL")),
  );

  effectIt.live("gives the synchronous check's answer for the same evidence", () =>
    Effect.gen(function* () {
      const child = yield* waitingChild;
      const pid = child.pid ?? 0;
      const started = processStartIdentity(pid);
      expect(started).toBeDefined();
      const exited = nodeSpawnSync(process.execPath, ["-e", ""]);
      const cases: ReadonlyArray<readonly [ProcessIdentity, string]> = [
        [currentProcessIdentity(), "alive"],
        [{ pid, started }, "alive"],
        [{ pid, started: `${started ?? ""}0` }, "dead"],
        [{ pid: exited.pid, started: "whenever" }, "dead"],
        [reusedProcessIdentity(), "dead"],
        [{ pid }, "unknown"],
        [{ pid, started: "an earlier process" }, "unknown"],
      ];
      for (const [identity, expected] of cases) {
        expect(yield* probeProcessLiveness(identity)).toBe(expected);
        expect(processLiveness(identity)).toBe(expected);
      }
    }),
  );
});

describe("non-blocking process liveness on Linux", () => {
  const platform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
  });

  effectIt.effect("is unknown when procfs refuses the read after the signal probe", () =>
    Effect.gen(function* () {
      Object.defineProperty(process, "platform", { value: "linux" });
      // The process exits, or procfs denies access, between the signal probe and the read.
      vi.spyOn(nodeLockFs, "readFileSync").mockImplementation(() => {
        throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      });
      // The parent process is present, and not this process, so its start is read from procfs.
      expect(yield* probeProcessLiveness({ pid: process.ppid, started: "proc:1" })).toBe("unknown");
    }),
  );
});
