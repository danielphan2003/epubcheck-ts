#!/usr/bin/env node
// Vendors a pinned, sparse copy of upstream EPUBCheck into vendor/epubcheck.
// Usage: node scripts/sync-upstream.ts [tag]
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  UPSTREAM_PATHS,
  UPSTREAM_REPOSITORY,
  UPSTREAM_TAG,
  UpstreamManifestJson,
} from "./lib/upstream.ts";

class UpstreamSyncError extends Schema.TaggedError<UpstreamSyncError>()("UpstreamSyncError", {
  step: Schema.String,
  exitCode: Schema.Number,
}) {
  override get message(): string {
    return `Upstream sync step "${this.step}" exited with code ${this.exitCode}.`;
  }
}

const run = Effect.fn("syncUpstream.run")(function* (
  step: string,
  command: string,
  args: ReadonlyArray<string>,
  cwd?: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(command, args, { cwd, stdout: "inherit", stderr: "inherit" }),
  );
  if (exitCode !== 0) {
    return yield* new UpstreamSyncError({ step, exitCode });
  }
});

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const tag = process.argv[2] ?? UPSTREAM_TAG;
  const root = path.resolve(import.meta.dirname, "..");
  const vendorDir = path.join(root, "vendor", "epubcheck");

  const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "epubcheck-upstream-" });
  yield* run("clone", "git", [
    "clone",
    "--quiet",
    "--depth=1",
    "--filter=blob:none",
    "--no-checkout",
    `--branch=${tag}`,
    UPSTREAM_REPOSITORY,
    checkout,
  ]);
  yield* run(
    "sparse-checkout",
    "git",
    ["sparse-checkout", "set", "--no-cone", ...UPSTREAM_PATHS.map((relative) => `/${relative}`)],
    checkout,
  );
  yield* run("checkout", "git", ["checkout", "--quiet"], checkout);
  const commit = (yield* spawner.string(
    ChildProcess.make("git", ["rev-parse", "HEAD"], { cwd: checkout }),
  )).trim();

  yield* fs.remove(vendorDir, { recursive: true, force: true });
  for (const relative of UPSTREAM_PATHS) {
    const target = path.join(vendorDir, relative);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.copy(path.join(checkout, relative), target);
  }
  const manifest = yield* Schema.encodeEffect(UpstreamManifestJson)({
    repository: UPSTREAM_REPOSITORY,
    tag,
    commit,
    paths: UPSTREAM_PATHS,
  });
  yield* fs.writeFileString(path.join(vendorDir, "UPSTREAM.json"), `${manifest}\n`);
  yield* Console.log(`Vendored ${UPSTREAM_REPOSITORY}@${tag} (${commit}) into ${vendorDir}`);
});

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
