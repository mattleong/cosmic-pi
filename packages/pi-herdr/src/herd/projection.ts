import type { HerdrAgentView, HerdrProjection } from "./model.ts";
import { isHerdrAgentActive } from "./model.ts";

const stateOrder: Readonly<Record<HerdrAgentView["state"], number>> = {
  blocked: 0,
  working: 1,
  starting: 2,
  awaiting_report: 3,
  unknown: 4,
  failed: 5,
  completed: 6,
  stopped: 7,
};

export const formatHerdrState = (state: HerdrAgentView["state"]): string =>
  state.replaceAll("_", " ");

export const sortHerdrAgents = (
  agents: ReadonlyArray<HerdrAgentView>,
): ReadonlyArray<HerdrAgentView> =>
  [...agents].sort(
    (left, right) =>
      stateOrder[left.state] - stateOrder[right.state] || right.updatedAt - left.updatedAt,
  );

export const emptyHerdrProjection = (): HerdrProjection => ({ revision: 0, agents: [] });

export const herdrFooterStatus = (projection: HerdrProjection): string | undefined => {
  const active = projection.agents.filter(
    (agent) =>
      isHerdrAgentActive(agent.state) && agent.state !== "blocked" && agent.report === undefined,
  ).length;
  const blocked = projection.agents.filter(
    (agent) => agent.state === "blocked" && agent.report === undefined,
  ).length;
  if (active === 0 && blocked === 0) return undefined;
  const parts = [
    active > 0 ? `${active} ${active === 1 ? "agent" : "agents"} active` : undefined,
    blocked > 0 ? `${blocked} blocked` : undefined,
  ].filter((value): value is string => value !== undefined);
  return `Herdr: ${parts.join(" · ")}`;
};
