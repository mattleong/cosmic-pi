import { describe, expect, it } from "@effect/vitest";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  nativeReportRequest,
  nativeReportServiceFixture,
  withService,
} from "./fixtures/service-harness.ts";

describe("runtime-native agent projection", () => {
  it.effect("keeps native agents inside one Pi run node and outside Pi limits", () => {
    const { backend, projections, layer } = nativeReportServiceFixture();
    return withService(layer, function* (service) {
      yield* service.start(nativeReportRequest({ model: "claude-native" }));
      const control = backend.controls[0]!;
      control.offer({
        type: "native_agent_activity",
        assignmentEpoch: control.assignmentEpochs[0]!,
        activityId: "native-1",
        kind: "Agent",
        state: "running",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.nativeActivity?.active === 1, 200);
      const active = yield* service.list;
      expect(active).toHaveLength(1);
      expect(active[0]?.nativeActivity).toMatchObject({ active: 1, total: 1 });
      expect(active[0]?.directChildCount).toBe(0);

      control.offer({
        type: "native_agent_activity",
        assignmentEpoch: control.assignmentEpochs[0]!,
        activityId: "native-1",
        kind: "Agent",
        state: "completed",
      });
      yield* yieldUntil(() => projections.at(-1)?.runs[0]?.nativeActivity?.active === 0, 200);
      expect((yield* service.list)[0]?.nativeActivity).toMatchObject({ active: 0, total: 1 });
    });
  });
});
