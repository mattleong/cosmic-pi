import * as Layer from "effect/Layer";
import type { HerdrForkSessionInput } from "./boundary/host-session.ts";
import { HerdrForkService } from "./fork/service.ts";

export const makeHerdrForkLayer = (input: HerdrForkSessionInput) => HerdrForkService.layer(input);

export type HerdrForkLayer = ReturnType<typeof makeHerdrForkLayer>;
export type HerdrForkApplication = Layer.Success<HerdrForkLayer>;
export type HerdrForkRuntimeError = Layer.Error<HerdrForkLayer>;
