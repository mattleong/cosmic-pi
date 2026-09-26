import { expect, it } from "@effect/vitest";
import { isInteractiveShellProcessName } from "../src/platform/shell-process-names.ts";

it("recognizes interactive shells by normalized process name only", () => {
  for (const name of ["zsh", "/bin/-zsh", "C:\\Program Files\\PowerShell\\pwsh.exe", "BASH"])
    expect(isInteractiveShellProcessName(name)).toBe(true);
  for (const name of ["node", "/usr/bin/git", "zsh-helper", ""])
    expect(isInteractiveShellProcessName(name)).toBe(false);
});
