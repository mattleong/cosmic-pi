import {
  getAgentDir,
  SettingsManager,
  type BashToolOptions,
  type ReadToolOptions,
} from "@earendil-works/pi-coding-agent";

export interface BuiltinToolOptions {
  bash?: BashToolOptions;
  read?: ReadToolOptions;
}

export function getBuiltinToolOptions(cwd: string, projectTrusted: boolean): BuiltinToolOptions {
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
  const commandPrefix = settings.getShellCommandPrefix();
  const shellPath = settings.getShellPath();
  return {
    bash: {
      ...(commandPrefix === undefined ? {} : { commandPrefix }),
      ...(shellPath === undefined ? {} : { shellPath }),
    },
    read: {
      autoResizeImages: settings.getImageAutoResize(),
    },
  };
}
