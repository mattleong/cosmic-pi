#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const pidPath = process.env.PI_SUBAGENT_TEST_PID ?? process.env.HERDR_CONFIG_PATH;
if (pidPath) await writeFile(pidPath, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
