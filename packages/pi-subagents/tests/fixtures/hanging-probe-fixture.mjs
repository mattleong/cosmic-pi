#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const pidPath =
  process.env.PI_SUBAGENT_TEST_PID ??
  // Standalone probe executable stays dependency-free, and HOME may be unset.
  // @effect-diagnostics-next-line preferEffectString:off
  (process.env.HOME?.includes("pi-subagents-probe-")
    ? join(process.env.HOME, "probe.pid")
    : undefined);
if (pidPath) await writeFile(pidPath, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
