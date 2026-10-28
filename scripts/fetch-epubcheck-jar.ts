#!/usr/bin/env node
// Downloads the pinned reference EPUBCheck release into .cache/epubcheck (never committed).
// Usage: node scripts/fetch-epubcheck-jar.ts
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { REFERENCE_JAR_URL, UPSTREAM_TAG } from "./lib/upstream.ts";

class FetchJarError extends Schema.TaggedError<FetchJarError>()("FetchJarError", {
  step: Schema.String,
  exitCode: Schema.Number,
}) {
  override get message(): string {
    return `Fetching the reference EPUBCheck jar failed at "${this.step}" (exit code ${this.exitCode}).`;
  }
}

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = path.resolve(import.meta.dirname, "..");
  const cacheDir = path.join(root, ".cache", "epubcheck");
  const version = UPSTREAM_TAG.slice(1);
  const jar = path.join(cacheDir, `epubcheck-${version}`, "epubcheck.jar");

  if (yield* fs.exists(jar)) {
    yield* Console.log(jar);
    return;
  }
  yield* fs.makeDirectory(cacheDir, { recursive: true });
  // The archive is untrusted input: download into its own empty directory and only unzip it.
  const download = yield* fs.makeTempDirectoryScoped({ prefix: "epubcheck-jar-" });
  const archive = path.join(download, `epubcheck-${version}.zip`);
  const steps: ReadonlyArray<readonly [string, string, ReadonlyArray<string>]> = [
    [
      "download",
      "curl",
      ["--fail", "--silent", "--show-error", "--location", "--output", archive, REFERENCE_JAR_URL],
    ],
    ["unzip", "unzip", ["-q", "-o", archive, "-d", cacheDir]],
  ];
  for (const [step, command, args] of steps) {
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(command, args, { stdout: "inherit", stderr: "inherit" }),
    );
    if (exitCode !== 0) return yield* new FetchJarError({ step, exitCode });
  }
  if (!(yield* fs.exists(jar)))
    return yield* new FetchJarError({ step: "locate jar", exitCode: 1 });
  yield* Console.log(jar);
});

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
