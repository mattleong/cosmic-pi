import type { SearchableSelectPageChoice } from "pi-cosmic-ui/manager/searchable-select";
import type { McpActionChoice, McpManagerAction, McpManagerServer } from "../manager/model.ts";
import { blockedExplanation, blockedLabel } from "../manager/policy.ts";

const disabledHint = (choice: McpActionChoice, row: McpManagerServer): string | undefined => {
  if (choice.reason !== "not-applicable") return choice.reason && blockedLabel[choice.reason];
  if ((choice.action === "auth" || choice.action === "logout") && row.authType !== "oauth")
    return "OAuth only";
  if (choice.action === "connect")
    return row.state === "connected"
      ? "Already connected"
      : row.state === "connecting"
        ? "Connecting"
        : row.state === "closing"
          ? "Disconnecting"
          : "Connection blocked";
  if (choice.action === "disconnect")
    return row.blockedReason === "cleanup-unconfirmed" ? "Cleanup unconfirmed" : "Not connected";
  return "Unavailable";
};

/** Highlight a useful enabled action without executing it or changing admission policy. */
export const actionMenu = (row: McpManagerServer) => {
  const choices = row.actions
    .filter((choice) => choice.action !== "inspect")
    .map(
      (choice): SearchableSelectPageChoice<McpManagerAction> => ({
        value: choice.action,
        payload: choice.action,
        item:
          choice.action === "connect"
            ? {
                value: choice.action,
                label: choice.label,
                description: "No metadata discovery, sign-in, or remote-health check.",
              }
            : { value: choice.action, label: choice.label },
        searchText: choice.label,
        enabled: choice.enabled,
        disabledReason: choice.reason ? blockedExplanation(choice.reason) : undefined,
        disabledHint: disabledHint(choice, row),
      }),
    );
  const preferred =
    row.auth === "required" || row.blockedReason === "auth-suspended"
      ? "auth"
      : row.metadata || row.metadataState === "checking" || row.metadataState === "refreshing"
        ? "browse"
        : "refresh";
  return {
    choices,
    current:
      choices.find((choice) => choice.value === preferred && choice.enabled)?.value ??
      choices.find((choice) => choice.value === "browse" && choice.enabled)?.value ??
      choices[0]?.value,
  };
};
