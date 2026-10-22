import * as Option from "effect/Option";
import * as Result from "effect/Result";

/** A decoder's rejection, or undefined when it accepted the input. */
export const rejection = <A, E>(result: Result.Result<A, E>): E | undefined =>
  Option.getOrUndefined(Result.getFailure(result));
