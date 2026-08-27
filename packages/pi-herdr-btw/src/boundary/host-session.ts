// Pi session and inherited Herdr process state are captured at the host boundary.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureSessionHost } from "pi-cosmic-core";
import { selectHerdrEnvironment } from "./herdr-client.ts";

// Synchronous host-boundary session validation needs raw Node fs/path semantics
// (lstat without a scoped Effect runtime); Effect FileSystem cannot express this
// pre-runtime capture contract.
const nodeFs = process.getBuiltinModule("node:fs");
const nodePath = process.getBuiltinModule("node:path");
if (!nodeFs || !nodePath) throw new Error("Node fs/path builtins are unavailable.");
const { lstatSync } = nodeFs;
const { basename, isAbsolute } = nodePath;

const MAX_SESSION_PATH_CHARS = 4_096;

export interface HerdrBtwSessionInput {
  readonly cwd: string;
  readonly sessionFile?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly sessionDir?: string | undefined;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}

interface CapturedHerdrBtwSession extends HerdrBtwSessionInput {
  readonly signal: AbortSignal | undefined;
  readonly aborted: boolean;
}

export const captureHerdrBtwSession = (
  ctx: ExtensionContext,
): CapturedHerdrBtwSession | undefined => {
  const host = captureSessionHost(ctx);
  if (host._tag === "Unavailable") return undefined;
  try {
    return {
      cwd: host.cwd,
      signal: host.signal,
      aborted: host.aborted,
      sessionFile: ctx.sessionManager.getSessionFile(),
      sessionId: ctx.sessionManager.getSessionId(),
      sessionDir: ctx.sessionManager.getSessionDir(),
      environment: selectHerdrEnvironment(process.env),
    };
  } catch {
    return undefined;
  }
};

export const isValidParentSessionFile = (path: string): boolean => {
  if (
    path.length > MAX_SESSION_PATH_CHARS ||
    path.includes("\0") ||
    path.includes("\n") ||
    path.includes("\r") ||
    !isAbsolute(path)
  )
    return false;
  try {
    const stat = lstatSync(path);
    return stat.isFile();
  } catch {
    return false;
  }
};

export const parentBtwDisplayName = (cwd: string): string => `BTW · ${basename(cwd) || "Pi"}`;
