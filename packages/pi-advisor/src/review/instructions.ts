import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { ReadOnlyFileSystem, type AdvisorProjectRoot } from "../boundary/read-only-fs.ts";

export const ADVISOR_INSTRUCTIONS_BASENAME = "ADVISOR.md";
export const MAX_INSTRUCTION_CHARS = 32_000;
export const MAX_INSTRUCTION_BYTES = 128_000;
export interface LoadedAdvisorInstructions {
  content?: string | undefined;
  paths: string[];
}

export const loadAdvisorInstructionsEffect = Effect.fn("AdvisorInstructions.load")(function* (
  configPath: string,
  cwd: string,
  projectTrusted: boolean,
) {
  const path = yield* Path.Path;
  const files = yield* ReadOnlyFileSystem;
  const agentDir = path.dirname(path.dirname(configPath));
  const candidates: Array<{
    path: string;
    lexicalRoot: string;
    root: AdvisorProjectRoot;
  }> = [];
  const agentRoot = yield* files.pinRoot(agentDir).pipe(Effect.catch(() => Effect.void));
  if (agentRoot) {
    candidates.push({
      path: path.join(agentDir, ADVISOR_INSTRUCTIONS_BASENAME),
      lexicalRoot: agentDir,
      root: agentRoot,
    });
  }
  if (projectTrusted) {
    const projectRoot = yield* files.pinRoot(cwd).pipe(Effect.catch(() => Effect.void));
    if (projectRoot) {
      candidates.push({
        path: path.join(cwd, CONFIG_DIR_NAME, ADVISOR_INSTRUCTIONS_BASENAME),
        lexicalRoot: cwd,
        root: projectRoot,
      });
    }
  }

  const blocks: string[] = [];
  const paths: string[] = [];
  for (const candidate of candidates) {
    const relation = path.relative(candidate.lexicalRoot, candidate.path);
    let current = candidate.lexicalRoot;
    let safe = true;
    for (const component of relation.split(path.sep).filter(Boolean)) {
      current = path.resolve(current, component);
      const info = yield* files.lstat(current).pipe(Effect.catch(() => Effect.void));
      if (!info || info.type === "symlink") {
        safe = false;
        break;
      }
    }
    if (!safe) continue;
    const result = yield* files
      .readBounded(candidate.path, candidate.root, MAX_INSTRUCTION_BYTES)
      .pipe(Effect.catch(() => Effect.void));
    const content = result ? new TextDecoder().decode(result.bytes).trim() : undefined;
    if (!content) continue;
    const bounded =
      content.length <= MAX_INSTRUCTION_CHARS && !result?.truncated
        ? content
        : `${content.slice(0, MAX_INSTRUCTION_CHARS)}\n\n[Advisor guidance truncated]`;
    paths.push(candidate.path);
    blocks.push(`Advisor guidance from ${candidate.path}:\n\n${bounded}`);
  }
  const loaded: LoadedAdvisorInstructions = { paths };
  return blocks.length > 0 ? { ...loaded, content: blocks.join("\n\n---\n\n") } : loaded;
});
