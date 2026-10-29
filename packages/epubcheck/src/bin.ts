#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Cli from "./cli/Cli.ts";
import * as EpubCheck from "./EpubCheck.ts";

Cli.main(process.argv.slice(2), {
  cwd: process.cwd(),
  defaultLocale: Intl.DateTimeFormat().resolvedOptions().locale,
  customMessageFile: process.env["ePubCheckCustomMessageFile"],
}).pipe(
  Effect.tap((outcome) => Effect.sync(() => void (process.exitCode = outcome.exitCode))),
  Effect.provide(
    Layer.mergeAll(EpubCheck.layer, Cli.terminalLayer).pipe(Layer.provideMerge(NodeServices.layer)),
  ),
  NodeRuntime.runMain,
);
