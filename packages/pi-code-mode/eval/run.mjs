#!/usr/bin/env node
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { createJiti } from "jiti";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const args = process.argv.slice(2);
const value = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!args.includes("--run")) {
  console.log(
    "Opt-in pilot: pnpm --filter pi-code-mode eval:pilot --run --experiment=formatter --provider=PROVIDER --model=MODEL --out=/absolute/new/directory --max-sessions=24",
  );
  console.log(
    "Formatter/wording replays require exactly 24 or 48 approved sessions. Adoption/output are archived and offline-only. All bundled cohorts are exposed regression material; fresh confirmation needs new tasks. Medium effort. Read-only fixtures. No model calls without --run.",
  );
} else {
  const provider = value("provider");
  const model = value("model");
  const output = value("out");
  const maxSessions = Number(value("max-sessions"));
  const experiment = value("experiment");
  if (experiment === "adoption" || experiment === "output")
    throw new Error(
      "Archived adoption/output experiments cannot reproduce their original interventions. Model-backed replay is disabled; use their offline fixtures and reports.",
    );
  if (experiment !== "wording" && experiment !== "formatter")
    throw new Error(
      "Choose --experiment=wording or --experiment=formatter for an approved regression replay.",
    );
  if (["wording", "formatter"].includes(experiment) && maxSessions !== 24 && maxSessions !== 48)
    throw new Error("This comparison requires --max-sessions=24 or --max-sessions=48.");
  if (
    !provider ||
    !model ||
    !output ||
    !isAbsolute(output) ||
    !Number.isSafeInteger(maxSessions) ||
    maxSessions < 1 ||
    maxSessions > 48
  ) {
    throw new Error(
      "Require --provider, --model, absolute --out, and --max-sessions between 1 and 48.",
    );
  }
  const known = /^(--run|--(?:provider|model|out|max-sessions|experiment)=.+)$/;
  if (args.some((arg) => !known.test(arg))) throw new Error("Unknown evaluation argument.");
  const authDir = getAgentDir();
  // Exclusive output creation prevents accidentally resuming or overwriting a previous budget.
  await mkdir(output, { mode: 0o700 });
  const scratch = await mkdtemp(join(tmpdir(), "code-mode-pilot-"));
  const agentDir = join(scratch, "agent");
  await mkdir(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const jiti = createJiti(import.meta.url);
    const { runPilot } = await jiti.import("./pilot.ts");
    await runPilot({
      scratch,
      agentDir,
      authDir,
      output,
      provider,
      model,
      maxSessions,
      experiment,
    });
  } catch {
    console.error(
      "Evaluation stopped on a setup, execution, or cleanup error. Completed attempts remain in the output directory. No automatic retry.",
    );
    process.exitCode = 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
