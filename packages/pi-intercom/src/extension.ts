import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSubagentChildProcess } from "pi-cosmic-core/host-environment";

export default function intercom(
  pi: ExtensionAPI,
  loadApplication = () => import("./application.ts"),
): void | Promise<void> {
  if (isSubagentChildProcess()) return;
  return loadApplication().then(({ registerIntercomApplication }) =>
    registerIntercomApplication(pi),
  );
}
