import { ACTIVITY_LIMITS } from "./limits.ts";
import type { ActivityItem } from "./protocol.ts";

/** Copies an item and cleans every display field; producer and host ingress supply their own cleaners. */
export const detachActivityItem = (
  item: ActivityItem,
  text: (value: string, limit: number) => string,
  detail: (value: string) => string,
): ActivityItem => {
  const detached = { ...item, title: text(item.title, ACTIVITY_LIMITS.title) };
  if (item.parent) Object.assign(detached, { parent: { ...item.parent } });
  if (item.profile !== undefined)
    Object.assign(detached, { profile: text(item.profile, ACTIVITY_LIMITS.profile) });
  if (item.route !== undefined)
    Object.assign(detached, { route: text(item.route, ACTIVITY_LIMITS.route) });
  if (item.summary !== undefined)
    Object.assign(detached, { summary: text(item.summary, ACTIVITY_LIMITS.text) });
  if (item.detail !== undefined) Object.assign(detached, { detail: detail(item.detail) });
  if (item.phase !== undefined)
    Object.assign(detached, { phase: text(item.phase, ACTIVITY_LIMITS.phaseTitle) });
  if (item.phases)
    Object.assign(detached, {
      phases: item.phases.map((phase) => {
        const value = { ...phase, title: text(phase.title, ACTIVITY_LIMITS.phaseTitle) };
        if (phase.detail !== undefined)
          Object.assign(value, { detail: text(phase.detail, ACTIVITY_LIMITS.text) });
        if (phase.work) Object.assign(value, { work: { ...phase.work } });
        return value;
      }),
    });
  if (item.actions)
    Object.assign(detached, {
      actions: item.actions.map((action) => {
        const value = { ...action, label: text(action.label, ACTIVITY_LIMITS.text) };
        if (action.confirmation !== undefined)
          Object.assign(value, { confirmation: text(action.confirmation, ACTIVITY_LIMITS.text) });
        return value;
      }),
    });
  return detached;
};
