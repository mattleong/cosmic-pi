import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { overlay } from "./overlay.ts";

export type HostSessionManager = ExtensionContext["sessionManager"];

export const FIXTURE_CWD = "/project";

export const sessionManagerFixture = (
  overrides: Partial<HostSessionManager> = {},
  cwd: string = FIXTURE_CWD,
): HostSessionManager => {
  const session = SessionManager.inMemory(cwd);
  return overlay<HostSessionManager>(
    {
      getCwd: session.getCwd.bind(session),
      getSessionDir: session.getSessionDir.bind(session),
      getSessionId: session.getSessionId.bind(session),
      getSessionFile: session.getSessionFile.bind(session),
      getLeafId: session.getLeafId.bind(session),
      getLeafEntry: session.getLeafEntry.bind(session),
      getEntry: session.getEntry.bind(session),
      getLabel: session.getLabel.bind(session),
      getBranch: session.getBranch.bind(session),
      buildContextEntries: session.buildContextEntries.bind(session),
      buildSessionProjection: session.buildSessionProjection.bind(session),
      getHeader: session.getHeader.bind(session),
      getEntries: session.getEntries.bind(session),
      getTree: session.getTree.bind(session),
      getSessionName: session.getSessionName.bind(session),
    },
    overrides,
  );
};
