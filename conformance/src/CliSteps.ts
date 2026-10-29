import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Cli, EpubCheck } from "epubcheck-ts";

import { type World, define, fail, noop, type StepDefinition } from "./Steps.ts";

// Upstream's CLISteps: run the command line in-process and assert on its streams, exit code and
// files. Inputs named `{{file}}` are copied to a scratch directory, where outputs land too, so the
// vendored fixtures stay untouched.

const scratchDir = Effect.fn("CliSteps.scratchDir")(function* (world: World) {
  if (world.scratchDir !== undefined) return world.scratchDir;
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "epubcheck-ts-cli-" });
  world.scratchDir = dir;
  return dir;
});

const resolveArgument = Effect.fn("CliSteps.resolveArgument")(function* (
  world: World,
  argument: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const match = /^\{\{(.+)\}\}$/.exec(argument);
  if (match === null) return argument;
  const name = match[1] ?? "";
  const dir = yield* scratchDir(world);
  const source = path.join(world.resourcesDir, world.basepath + name);
  const target = path.join(dir, name);
  if (yield* fs.exists(source).pipe(Effect.orElseSucceed(() => false))) {
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.copy(source, target);
  }
  return target;
});

const runCommand = Effect.fn("CliSteps.runCommand")(function* (world: World, command: string) {
  const dir = yield* scratchDir(world);
  const args = yield* Effect.forEach(
    command.split(/\s+/).filter((argument) => argument !== ""),
    (argument) => resolveArgument(world, argument),
  );
  let stdout = "";
  let stderr = "";
  const terminal = Cli.Terminal.of({
    stdout: Effect.fnUntraced(function* (text: string) {
      yield* Effect.sync(() => {
        stdout += text;
      });
    }),
    stderr: Effect.fnUntraced(function* (text: string) {
      yield* Effect.sync(() => {
        if (world.redirectStderr) stdout += text;
        else stderr += text;
      });
    }),
  });
  const outcome = yield* Cli.main(args, { cwd: dir, defaultLocale: world.defaultLocale }).pipe(
    Effect.provideService(Cli.Terminal, terminal),
  );
  world.run = {
    exitCode: outcome.exitCode,
    stdout,
    stderr,
    maxOfEachMessage: outcome.maxOfEachMessage,
  };
});

const stream = (world: World, name: string) =>
  world.run === undefined ? undefined : name === "stdout" ? world.run.stdout : world.run.stderr;

const expected = (text: string) => text.replaceAll("{{VERSION}}", EpubCheck.VERSION);

const streamAssertion = (
  name: string,
  verb: string,
  holds: (actual: string, text: string) => boolean,
) =>
  define(
    `{stream} ${verb} {string}`,
    Schema.Tuple([Schema.String, Schema.String]),
    (world, [which, text]) => {
      const actual = stream(world, which);
      if (actual === undefined) return fail("The command was not run");
      return holds(actual, expected(text))
        ? noop
        : fail(`Expected ${which} ${name} "${text}" but it was:\n${actual}`);
    },
  );

const fileExists = Effect.fn("CliSteps.fileExists")(function* (world: World, name: string) {
  if (world.scratchDir === undefined) return false;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs
    .exists(path.join(world.scratchDir, name))
    .pipe(Effect.orElseSucceed(() => false));
});

export const cliSteps: ReadonlyArray<StepDefinition> = [
  define("running `epubcheck( ){}`", Schema.Tuple([Schema.String]), (world, [command]) =>
    runCommand(world, command).pipe(
      Effect.catchTags({ PlatformError: (error) => fail(error.message) }),
    ),
  ),
  define("stderr is redirected to stdout", Schema.Tuple([]), (world) =>
    Effect.sync(() => {
      world.redirectStderr = true;
    }),
  ),
  define("the return code is {int}", Schema.Tuple([Schema.Number]), (world, [code]) =>
    world.run?.exitCode === code
      ? noop
      : fail(`Expected return code ${code} but got ${world.run?.exitCode}\n${world.run?.stderr}`),
  ),
  define("{stream} is", Schema.Tuple([Schema.String]), (world, [which], step) => {
    const actual = stream(world, which);
    const text = expected(step.argument?.docString?.content ?? "");
    return actual?.replaceAll("\r\n", "\n").trimEnd() === text.trimEnd()
      ? noop
      : fail(`Expected ${which} to be:\n${text}\nbut it was:\n${actual}`);
  }),
  define("{stream} is empty", Schema.Tuple([Schema.String]), (world, [which]) => {
    const actual = stream(world, which);
    return actual === "" ? noop : fail(`Expected ${which} to be empty but it was:\n${actual}`);
  }),
  streamAssertion("to contain", "contains", (actual, text) => actual.includes(text)),
  streamAssertion("not to contain", "does not contain", (actual, text) => !actual.includes(text)),
  streamAssertion("to start with", "starts with", (actual, text) => actual.startsWith(text)),
  define("file {string} does not exist", Schema.Tuple([Schema.String]), (world, [name]) =>
    fileExists(world, name).pipe(
      Effect.flatMap((exists) => (exists ? fail(`File ${name} exists`) : noop)),
    ),
  ),
  define("file {string} was created", Schema.Tuple([Schema.String]), (world, [name]) =>
    fileExists(world, name).pipe(
      Effect.flatMap((exists) => (exists ? noop : fail(`File ${name} was not created`))),
    ),
  ),
  define(
    "the report uses {int} maximum number of unique messages",
    Schema.Tuple([Schema.Number]),
    (world, [max]) =>
      world.run?.maxOfEachMessage === max
        ? noop
        : fail(`Expected a maximum of ${max} but got ${world.run?.maxOfEachMessage}`),
  ),
  define("the report uses an unlimited number of unique messages", Schema.Tuple([]), (world) =>
    world.run?.maxOfEachMessage !== undefined && world.run.maxOfEachMessage < 0
      ? noop
      : fail(`Expected no maximum but got ${world.run?.maxOfEachMessage}`),
  ),
];
