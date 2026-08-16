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
    bash: (() => {
      const objectPart532_0 = {};
      const objectPart532_1 =
        commandPrefix === undefined ? objectPart532_0 : { ...objectPart532_0, commandPrefix };
      const objectPart532_2 =
        shellPath === undefined ? objectPart532_1 : { ...objectPart532_1, shellPath };
      return objectPart532_2;
    })(),
    read: {
      autoResizeImages: settings.getImageAutoResize(),
    },
  };
}
