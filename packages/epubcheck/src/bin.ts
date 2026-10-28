#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Cli from "./cli/Cli.ts";
import * as EpubCheck from "./EpubCheck.ts";

Cli.main(process.argv.slice(2)).pipe(
  Effect.provide(EpubCheck.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  NodeRuntime.runMain,
);
