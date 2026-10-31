#!/usr/bin/env node
// Resolves what a release run publishes: version, tag, prerelease flags, and the previous tag
// its notes compare with. Usage: node scripts/resolve-release.ts --version v1.2.3 [--github-output]
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { InvalidReleaseVersion, parseRelease, previousReleaseTag } from "./lib/release.ts";

class TagListFailed extends Schema.TaggedError<TagListFailed>()("TagListFailed", {
  exitCode: Schema.Number,
}) {
  override get message(): string {
    return `git tag --list exited with code ${this.exitCode}; fetch tags before resolving a release.`;
  }
}

const listTags = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(ChildProcess.make("git", ["tag", "--list", "v*"]));
  const [output, exitCode] = yield* Effect.all(
    [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
    { concurrency: 2 },
  );
  if (exitCode !== 0) return yield* new TagListFailed({ exitCode });
  return output.split("\n").filter((line) => line.length > 0);
}).pipe(Effect.scoped);

const resolve = Command.make(
  "resolve-release",
  {
    version: Flag.String("version").pipe(
      Flag.withDescription("Release version or tag, such as v1.2.3 or 1.2.3-rc.1."),
    ),
    githubOutput: Flag.Boolean("github-output").pipe(
      Flag.withDescription("Append the results to $GITHUB_OUTPUT instead of printing them."),
      Flag.withDefault(false),
    ),
  },
  Effect.fn("resolveRelease")(function* ({ version, githubOutput }) {
    const release = parseRelease(version);
    if (Option.isNone(release)) return yield* new InvalidReleaseVersion({ raw: version });
    const previous = previousReleaseTag(
      (yield* listTags).filter((tag) => tag !== release.value.tag),
      release.value,
    );
    const lines = [
      `version=${release.value.version}`,
      `tag=${release.value.tag}`,
      `is_prerelease=${release.value.isPrerelease}`,
      `make_latest=${release.value.makeLatest}`,
      `previous_tag=${Option.getOrElse(previous, () => "")}`,
    ].join("\n");
    if (!githubOutput) return yield* Console.log(lines);
    const outputPath = yield* Config.String("GITHUB_OUTPUT");
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(outputPath, `${lines}\n`, { flag: "a" });
    yield* Console.log(lines);
  }),
);

Command.run(resolve, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
