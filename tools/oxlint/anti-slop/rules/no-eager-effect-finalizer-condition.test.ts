import { RuleTester } from "oxlint/plugins-dev";

import { noEagerEffectFinalizerConditionRule } from "./no-eager-effect-finalizer-condition.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const prelude = `import { Effect, Queue } from "effect";`;
const error = { messageId: "eagerCondition" };

const localCliPort = `
  import * as Effect from "effect/Effect";
  import * as Queue from "effect/Queue";
  const offer = (event, raw) => Effect.suspend(() => {
    if (raw) rawOwners.set(event, raw);
    let offered = false;
    return Queue.offer(events, event).pipe(
      Effect.tap(() => Effect.sync(() => void (offered = true))),
      Effect.ensuring(
        offered
          ? Effect.void
          : Effect.logWarning(
              \`Subagent local-CLI event ingress overflowed; dropped a \${event.type} event.\`,
            ).pipe(Effect.andThen(Effect.sync(() => raw && acknowledge(event)))),
      ),
      Effect.asVoid,
    );
  });
`;
const localPiPort = `
  import * as Effect from "effect/Effect";
  import * as Queue from "effect/Queue";
  const offerEvent = (raw, event) => Effect.suspend(() => {
    rawEventOwners.set(event, raw);
    let offered = false;
    return Queue.offer(events, event).pipe(
      Effect.tap(() => Effect.sync(() => { offered = true; })),
      Effect.ensuring(
        offered
          ? Effect.void
          : Effect.logWarning(
              \`Subagent local-Pi event ingress overflowed; dropped a \${event.type} event.\`,
            ).pipe(Effect.andThen(Effect.sync(() => acknowledge(event)))),
      ),
      Effect.asVoid,
    );
  });
`;

tester.run("anti-slop/no-eager-effect-finalizer-condition", noEagerEffectFinalizerConditionRule, {
  valid: [
    `${prelude}
      const admitted = true;
      work.pipe(Effect.ensuring(admitted ? Effect.void : cleanup));`,
    `${prelude}
      let admitted = false; admitted = true;
      work.pipe(Effect.ensuring(admitted ? Effect.void : cleanup));`,
    `${prelude}
      let offered = false;
      Effect.sync(() => { offered = true; });
      work.pipe(Effect.ensuring(offered ? Effect.void : cleanup));`,
    `${prelude}
      let offered = false;
      const other = work.pipe(Effect.tap(() => Effect.sync(() => { offered = true; })));
      work.pipe(Effect.ensuring(offered ? Effect.void : cleanup));`,
    `${prelude}
      let offered = false;
      work.pipe(Effect.ensuring(offered ? Effect.void : cleanup),
        Effect.tap(() => Effect.sync(() => { offered = true; })));`,
    `${prelude}
      let offered = false;
      work.pipe(Effect.tap(() => Effect.sync(() => { offered = true; })),
        Effect.ensuring(Effect.suspend(() => offered ? Effect.void : cleanup)));`,
    `${prelude}
      let confirmed = false;
      work.pipe(Effect.tap(() => Effect.sync(() => { confirmed = true; })),
        Effect.ensuring(Effect.sync(() => { if (!confirmed) disable(); })));`,
    `${prelude}
      const admitted = true; let offered = false;
      work.pipe(Effect.tap(() => Effect.sync(() => { offered = true; })),
        Effect.ensuring(admitted ? Effect.succeed(offered) : cleanup));`,
    `${prelude}
      const admitted = true; let offered = false;
      work.pipe(Effect.tap(() => Effect.sync(() => { offered = true; })),
        Effect.ensuring((admitted as typeof offered) ? Effect.void : cleanup));`,
    `import { ensuring as finalize, suspend as defer, tap, sync } from "effect/Effect";
      let offered = false;
      work.pipe(tap(() => sync(() => { offered = true; })),
        finalize(defer(() => offered ? done : cleanup)));`,
    `${prelude}
      let offered = false;
      work.pipe(Effect.tap(() => Effect.sync(() => { let offered = false; offered = true; })),
        Effect.ensuring(offered ? Effect.void : cleanup));`,
    `${prelude}
      let offered = false;
      work.pipe(Effect.tap((offered) => Effect.sync(() => { offered = true; })),
        Effect.ensuring(offered ? Effect.void : cleanup));`,
    `const Effect = fake; let offered = false;
      work.pipe(Effect.tap(() => Effect.sync(() => { offered = true; })),
        Effect.ensuring(offered ? Effect.void : cleanup));`,
    `import { Effect } from "another-library"; let offered = false;
      work.pipe(Effect.tap(() => Effect.sync(() => { offered = true; })),
        Effect.ensuring(offered ? Effect.void : cleanup));`,
    `${prelude}
      function create(Effect) {
        let offered = false;
        return work.pipe(Effect.tap(() => Effect.sync(() => { offered = true; })),
          Effect.ensuring(offered ? Effect.void : cleanup));
      }`,
    `${prelude}
      let offered = false;
      work.pipe(fake.tap(() => Effect.sync(() => { offered = true; })),
        Effect.ensuring(offered ? Effect.void : cleanup));`,
    `${prelude}
      let E = Effect; E = fake; let offered = false;
      work.pipe(E.tap(() => E.sync(() => { offered = true; })),
        E.ensuring(offered ? E.void : cleanup));`,
    `import type { Effect } from "effect"; let offered = false;
      work.pipe(Effect.tap(() => Effect.sync(() => { offered = true; })),
        Effect.ensuring(offered ? Effect.void : cleanup));`,
    `${prelude}
      let offered = false;
      work.pipe(Effect.tap(() => {
        const unrelated = Effect.sync(() => { offered = true; });
        return Effect.void;
      }), Effect.ensuring(offered ? Effect.void : cleanup));`,
    `${prelude}
      let offered = false;
      work.pipe(Effect.tap(() => {
        const unrelated = () => { offered = true; };
        return Effect.void;
      }), Effect.ensuring(offered ? Effect.void : cleanup));`,
    `${prelude}
      let offered = false;
      work.pipe(Effect.map(() => Effect.sync(() => { offered = true; })),
        Effect.ensuring(offered ? Effect.void : cleanup));`,
    `${prelude}
      let offered = false;
      Effect.gen(function* () { return Effect.sync(() => { offered = true; }); }).pipe(
        Effect.ensuring(offered ? Effect.void : cleanup));`,
    `${prelude}
      const state = { offered: false };
      work.pipe(Effect.tap(() => Effect.sync(() => { state.offered = true; })),
        Effect.ensuring(state.offered ? Effect.void : cleanup));`,
    `${prelude}
      let offered = false;
      work.pipe(Effect.tap(() => Effect.sync(() => { offered = true; })),
        Effect.ensuring(state.offered ? Effect.void : cleanup));`,
  ],
  invalid: [
    { code: localCliPort, errors: [error], output: null },
    { code: localPiPort, errors: [error], output: null },
    {
      code: `${prelude}
        let offered = false;
        work.pipe(Effect.tap(() => Effect.sync(() => { offered = true; })),
          Effect.ensuring(offered && cleanup));`,
      errors: [error],
    },
    {
      code: `${prelude}
        let offered = false;
        work.pipe(Effect.tap(() => Effect.sync(() => { offered = true; })),
          Effect.ensuring(offered || cleanup));`,
      errors: [error],
    },
    {
      code: `${prelude}
        let result;
        work.pipe(Effect.tap(() => Effect.sync(() => { result = cleanup; })),
          Effect.ensuring(result ?? cleanup));`,
      errors: [error],
    },
    {
      code: `${prelude}
        let offered = false;
        Effect.ensuring(
          Effect.tap(work, () => Effect.sync(() => { offered = true; })),
          offered ? Effect.void : cleanup);`,
      errors: [error],
    },
    {
      code: `${prelude}
        let offered = false;
        Effect.ensuring(
          Effect.tap(() => Effect.sync(() => { offered = true; }))(work),
          offered ? Effect.void : cleanup);`,
      errors: [error],
    },
    {
      code: `${prelude}
        let offered = false;
        Effect.ensuring(offered ? Effect.void : cleanup)(
          Effect.tap(work, () => Effect.sync(() => { offered = true; })));`,
      errors: [error],
    },
    {
      code: `import { Effect as E, pipe } from "effect";
        let offered = false;
        pipe(work, E.tap(() => E.sync(() => { offered = true; })),
          E.ensuring(offered ? E.void : cleanup));`,
      errors: [error],
    },
    {
      code: `import * as Fx from "effect";
        import { pipe as compose } from "effect/Function";
        let offered = false;
        compose(work, Fx.Effect.tap(() => Fx.Effect.sync(() => { offered = true; })),
          Fx.Effect.ensuring(offered ? Fx.Effect.void : cleanup));`,
      errors: [error],
    },
    {
      code: `import { ensuring as finalize, tap as observe, sync as defer } from "effect/Effect";
        let offered = false;
        work.pipe(observe(() => defer(() => { offered = true; })),
          finalize(offered ? done : cleanup));`,
      errors: [error],
    },
    {
      code: `${prelude}
        const E = Effect; const finalize = E.ensuring;
        const { tap: observe, sync: defer } = E;
        let offered = false;
        work.pipe(observe(() => defer(() => { offered = true; })),
          finalize(offered ? E.void : cleanup));`,
      errors: [error],
    },
    {
      code: `${prelude}
        let offered = false;
        const mark = () => Effect.sync(() => { offered = true; });
        const source = work.pipe(Effect.tap(mark));
        source.pipe(Effect.ensuring(offered ? Effect.void : cleanup));`,
      errors: [error],
    },
    {
      code: `${prelude}
        let offered = false;
        function mark() { return Effect.sync(() => { offered = true; }); }
        work.pipe(Effect.flatMap(mark)).pipe(
          Effect.ensuring((offered as boolean) ? Effect.void : cleanup));`,
      errors: [error],
    },
    {
      code: `${prelude}
        let offered = false;
        Effect.ensuring(Effect.suspend(() => {
          if (ready) return Effect.sync(() => { offered = true; });
          return Effect.void;
        }), offered ? Effect.void : cleanup);`,
      errors: [error],
    },
    {
      code: `${prelude}
        let count = 0;
        Effect.gen(function* () { yield* work; count++; }).pipe(
          Effect.ensuring(count > 0 ? Effect.void : cleanup));`,
      errors: [error],
    },
    {
      code: `${prelude}
        let offered = false;
        Effect.gen(function* () { yield* Effect.sync(() => { offered = true; }); }).pipe(
          Effect.ensuring(offered ? Effect.void : cleanup));`,
      errors: [error],
    },
    {
      code: `${prelude}
        let offered = false;
        work.pipe(Effect.tap(() => Effect.sync(() => { ({ offered } = result); })),
          Effect.ensuring(offered ? Effect.void : cleanup));`,
      errors: [error],
    },
    {
      code: `${prelude}
        function create(offered) {
          return work.pipe(Effect.map(() => { offered = true; }),
            Effect.ensuring(offered ? Effect.void : cleanup));
        }`,
      errors: [error],
    },
  ],
});

tester.run(
  "anti-slop/no-eager-effect-finalizer-condition file reset",
  noEagerEffectFinalizerConditionRule,
  {
    valid: [
      `let offered = false;
      work.pipe(Effect.tap(() => Effect.sync(() => { offered = true; })),
        Effect.ensuring(offered ? Effect.void : cleanup));`,
      `${prelude}
      let offered = false;
      work.pipe(Effect.ensuring(offered ? Effect.void : cleanup));`,
    ],
    invalid: [],
  },
);
