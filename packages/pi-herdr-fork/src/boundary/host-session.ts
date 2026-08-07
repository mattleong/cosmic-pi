// Pi session and inherited Herdr process state are captured at the host boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
import { lstatSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectHerdrEnvironment } from "./herdr-client.ts";

const MAX_SESSION_PATH_CHARS = 4_096;

export interface HerdrForkSessionInput {
  readonly cwd: string;
  readonly sessionFile?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}

export const captureHerdrForkSession = (
  ctx: ExtensionContext,
): HerdrForkSessionInput | undefined => {
  try {
    return {
      cwd: ctx.cwd,
      sessionFile: ctx.sessionManager.getSessionFile(),
      sessionId: ctx.sessionManager.getSessionId(),
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

export const parentForkDisplayName = (cwd: string): string => `Fork · ${basename(cwd) || "Pi"}`;
