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

import { REFERENCE_JAR_SHA256, referenceJarUrl, UpstreamManifestJson } from "./lib/upstream.ts";

class FetchJarError extends Schema.TaggedError<FetchJarError>()("FetchJarError", {
  step: Schema.String,
  exitCode: Schema.Number,
}) {
  override get message(): string {
    return `Fetching the reference EPUBCheck jar failed at "${this.step}" (exit code ${this.exitCode}).`;
  }
}

class ChecksumMismatch extends Schema.TaggedError<ChecksumMismatch>()("ChecksumMismatch", {
  tag: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {
  override get message(): string {
    return `The EPUBCheck ${this.tag} archive has SHA-256 ${this.actual}, expected ${this.expected}.`;
  }
}

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = path.resolve(import.meta.dirname, "..");
  const cacheDir = path.join(root, ".cache", "epubcheck");
  // Fetch the release matching the vendored tests, and only with a pinned checksum.
  const { tag } = yield* Schema.decodeEffect(UpstreamManifestJson)(
    yield* fs.readFileString(path.join(root, "vendor/epubcheck/UPSTREAM.json")),
  );
  const expected = REFERENCE_JAR_SHA256[tag];
  if (expected === undefined) {
    return yield* new ChecksumMismatch({
      tag,
      expected: "(none pinned)",
      actual: "(not downloaded)",
    });
  }
  const version = tag.slice(1);
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
      [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--output",
        archive,
        referenceJarUrl(tag),
      ],
    ],
    ["unzip", "unzip", ["-q", "-o", archive, "-d", cacheDir]],
  ];
  for (const [step, command, args] of steps) {
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(command, args, { stdout: "inherit", stderr: "inherit" }),
    );
    if (exitCode !== 0) return yield* new FetchJarError({ step, exitCode });
    // The jar gets executed later, so refuse an archive that is not the pinned release.
    if (step === "download") {
      const bytes = yield* fs.readFile(archive);
      const digest = yield* Effect.promise(() =>
        crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
      );
      const actual = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      if (actual !== expected) return yield* new ChecksumMismatch({ tag, expected, actual });
    }
  }
  if (!(yield* fs.exists(jar)))
    return yield* new FetchJarError({ step: "locate jar", exitCode: 1 });
  yield* Console.log(jar);
});

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
