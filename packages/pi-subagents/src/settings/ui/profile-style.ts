import type { Theme } from "@earendil-works/pi-coding-agent";
import { listDetailFrame } from "pi-cosmic-ui/manager/list-detail-shell";
import { focusedField, managerTone } from "pi-cosmic-ui/manager/style";

export const profileTone = {
  ...managerTone,
  profile: managerTone.identity,
  model: managerTone.value,
} as const;

export const focusedProfileField = focusedField;

export const profileFrame = (theme: Theme, focused = false) =>
  listDetailFrame(theme, focused ? "list" : undefined);
