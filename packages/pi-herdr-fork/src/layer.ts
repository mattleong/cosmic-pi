import * as Layer from "effect/Layer";
import type { HerdrForkSessionInput } from "./boundary/host-session.ts";
import { HerdrForkService, makeHerdrForkService } from "./fork/service.ts";

export const makeHerdrForkLayer = (input: HerdrForkSessionInput) =>
  Layer.succeed(HerdrForkService, makeHerdrForkService(input));

export type HerdrForkLayer = ReturnType<typeof makeHerdrForkLayer>;
export type HerdrForkApplication = Layer.Success<HerdrForkLayer>;
export type HerdrForkRuntimeError = Layer.Error<HerdrForkLayer>;
