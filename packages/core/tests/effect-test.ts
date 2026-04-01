import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import { it as base } from "vite-plus/test";

type TestServices = TestConsole.TestConsole | TestClock.TestClock;
const TestEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer());

const runPromise = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const exit = yield* Effect.exit(effect);
      if (Exit.isFailure(exit)) {
        for (const error of Cause.prettyErrors(exit.cause)) {
          yield* Effect.logError(error);
        }
      }
      return yield* exit;
    }),
  );

type EffectFn = () => Effect.Effect<unknown, unknown, Scope.Scope | TestServices>;

const run = (fn: EffectFn) => runPromise(fn().pipe(Effect.scoped, Effect.provide(TestEnv)));

function effect(name: string, fn: EffectFn, timeout?: number) {
  base(name, () => run(fn), timeout);
}

effect.skip = (name: string, fn: EffectFn, timeout?: number) => {
  base.skip(name, () => run(fn), timeout);
};

effect.only = (name: string, fn: EffectFn, timeout?: number) => {
  base.only(name, () => run(fn), timeout);
};

type LiveFn = () => Effect.Effect<unknown, unknown, Scope.Scope>;

const runLive = (fn: LiveFn) => runPromise(fn().pipe(Effect.scoped));

function live(name: string, fn: LiveFn, timeout?: number) {
  base(name, () => runLive(fn), timeout);
}

live.skip = (name: string, fn: LiveFn, timeout?: number) => {
  base.skip(name, () => runLive(fn), timeout);
};

live.only = (name: string, fn: LiveFn, timeout?: number) => {
  base.only(name, () => runLive(fn), timeout);
};

export const it = Object.assign(base, { effect, live });
