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
  const bashOptions: BashToolOptions = {};
  if (commandPrefix !== undefined) bashOptions.commandPrefix = commandPrefix;
  if (shellPath !== undefined) bashOptions.shellPath = shellPath;
  return {
    bash: bashOptions,
    read: {
      autoResizeImages: settings.getImageAutoResize(),
    },
  };
}
