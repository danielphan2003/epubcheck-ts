import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EpubCheck from "./EpubCheck.ts";

const layer = EpubCheck.layer.pipe(Layer.provide(NodeServices.layer));

// Promise boundary for callers outside Effect; runs the Node-backed checker.
export const check = (request: EpubCheck.CheckRequest) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const checker = yield* EpubCheck.EpubCheck;
      return yield* checker.check(request);
    }).pipe(Effect.provide(layer)),
  );

export type { CheckRequest, CheckResult } from "./EpubCheck.ts";
export type { Message, Location } from "./report/Report.ts";
