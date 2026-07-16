import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const ADVISOR_INSTRUCTIONS_BASENAME = "ADVISOR.md";
const MAX_INSTRUCTION_CHARS = 32_000;

export interface LoadedAdvisorInstructions {
  content?: string;
  paths: string[];
}

export function loadAdvisorInstructions(
  configPath: string,
  cwd: string,
  projectTrusted: boolean,
): LoadedAdvisorInstructions {
  const agentDir = dirname(dirname(configPath));
  const candidates = [join(agentDir, ADVISOR_INSTRUCTIONS_BASENAME)];
  if (projectTrusted) {
    candidates.push(join(cwd, CONFIG_DIR_NAME, ADVISOR_INSTRUCTIONS_BASENAME));
  }

  const blocks: string[] = [];
  const paths: string[] = [];
  for (const path of candidates) {
    const content = readInstructions(path);
    if (!content) continue;
    paths.push(path);
    blocks.push(`Advisor guidance from ${path}:\n\n${content}`);
  }

  return {
    ...(blocks.length > 0 ? { content: blocks.join("\n\n---\n\n") } : {}),
    paths,
  };
}

function readInstructions(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const content = readFileSync(path, "utf8").trim();
    if (!content) return undefined;
    if (content.length <= MAX_INSTRUCTION_CHARS) return content;
    return `${content.slice(0, MAX_INSTRUCTION_CHARS)}\n\n[Advisor guidance truncated]`;
  } catch {
    return undefined;
  }
}
