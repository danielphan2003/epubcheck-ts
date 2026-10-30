#!/usr/bin/env node
// Installs a packed epubcheck-ts tarball into an empty project, the way a consumer would, and
// runs its CLI and both entry points against upstream fixtures. The release publishes only a
// tarball that passes. Usage: node scripts/smoke-tarball.ts --tarball path/to/epubcheck-ts-X.Y.Z.tgz
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

class SmokeFailed extends Schema.TaggedError<SmokeFailed>()("SmokeFailed", {
  step: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Tarball smoke test failed at "${this.step}": ${this.detail}`;
  }
}

const FIXTURES = "vendor/epubcheck/src/test/resources/epub3";
const VALID = `${FIXTURES}/00-minimal/files/minimal.epub`;
const INVALID = `${FIXTURES}/04-ocf/files/ocf-mimetype-file-missing-error.epub`;

// Runs inside the consumer project, so it sees only what the tarball installed.
const CONSUMER_CHECK = `
import * as Fs from "node:fs";
import * as Library from "epubcheck-ts";
import { check } from "epubcheck-ts/promise";

const [valid, invalid] = process.argv.slice(2);
const fail = (reason) => { console.error(reason); process.exit(1); };
const root = new URL("./node_modules/epubcheck-ts/", import.meta.url);
const manifest = JSON.parse(Fs.readFileSync(new URL("package.json", root), "utf8"));

for (const [entry, target] of Object.entries(manifest.exports)) {
  for (const file of [target.types, target.import]) {
    if (!Fs.existsSync(new URL(file, root))) fail(\`export \${entry} points at missing \${file}\`);
  }
}
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  if (!Fs.existsSync(new URL(file, root))) fail(\`the tarball has no \${file}\`);
}
if (Fs.existsSync(new URL("src", root))) fail("the tarball ships src/");
for (const name of Object.values(manifest.dependencies ?? {})) {
  if (String(name).startsWith("catalog:") || String(name).startsWith("workspace:")) {
    fail(\`an unresolved dependency spec \${name} reached the tarball\`);
  }
}
if (typeof Library.EpubCheck?.layer !== "object") fail("epubcheck-ts does not export EpubCheck.layer");

const severe = (result) =>
  result.messages.filter((message) => message.severity === "ERROR" || message.severity === "FATAL");
const clean = await check({ path: valid });
if (severe(clean).length > 0) fail(\`a valid EPUB reported \${JSON.stringify(severe(clean))}\`);
const broken = await check({ path: invalid });
if (!broken.messages.some((message) => message.id === "PKG-006")) {
  fail(\`a missing mimetype did not report PKG-006: \${JSON.stringify(broken.messages)}\`);
}
console.log("library entry points: ok");
`;

const smoke = Command.make(
  "smoke-tarball",
  {
    tarball: Flag.String("tarball").pipe(Flag.withDescription("The packed tarball to install.")),
  },
  Effect.fn("smokeTarball")(function* ({ tarball }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const root = path.resolve(import.meta.dirname, "..");
    const archive = path.resolve(tarball);
    const valid = path.join(root, VALID);
    const invalid = path.join(root, INVALID);
    if (!(yield* fs.exists(archive))) {
      return yield* new SmokeFailed({ step: "locate", detail: `${archive} does not exist` });
    }

    // Outside the workspace, so nothing resolves from this repository's node_modules.
    const project = yield* fs.makeTempDirectoryScoped({ prefix: "epubcheck-ts-smoke-" });
    yield* fs.writeFileString(
      path.join(project, "package.json"),
      '{ "name": "epubcheck-ts-smoke", "private": true, "type": "module" }\n',
    );
    yield* fs.writeFileString(path.join(project, "consumer.mjs"), CONSUMER_CHECK);

    const run = Effect.fn("smokeTarball.run")(function* (
      step: string,
      command: string,
      args: ReadonlyArray<string>,
      expected: number,
    ) {
      const exitCode = yield* spawner.exitCode(
        ChildProcess.make(command, args, { cwd: project, stdout: "inherit", stderr: "inherit" }),
      );
      if (exitCode !== expected) {
        return yield* new SmokeFailed({
          step,
          detail: `exit code ${exitCode}, expected ${expected}`,
        });
      }
    });

    yield* run("install", "pnpm", ["add", archive], 0);
    yield* run(
      "CLI on a valid EPUB",
      path.join(project, "node_modules/.bin/epubcheck-ts"),
      [valid],
      0,
    );
    yield* run(
      "CLI on an invalid EPUB",
      path.join(project, "node_modules/.bin/epubcheck-ts"),
      [invalid],
      1,
    );
    yield* run("library entry points", "node", ["consumer.mjs", valid, invalid], 0);
    yield* Console.log(`${path.basename(archive)} installs and runs.`);
  }),
);

Command.run(smoke, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
